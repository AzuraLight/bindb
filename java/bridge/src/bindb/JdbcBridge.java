package bindb;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.PrintStream;
import java.io.Writer;
import java.math.BigDecimal;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.Driver;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.Statement;
import java.sql.Types;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * BindB JDBC 연동 런타임. 확장(Node)이 필요할 때만 띄우는 JVM에서 JDBC 드라이버를 실행한다
 * (DataGrip의 RemoteJdbcServer와 같은 구조: 드라이버가 죽어도 확장은 멀쩡하다).
 *
 * 프로토콜: 표준 입력으로 요청 JSON 한 줄, 표준 출력으로 응답 JSON 한 줄. 네트워크 포트는 열지 않는다.
 *   요청  {"id":1,"op":"open","jars":[…],"driver":"org.h2.Driver","url":"jdbc:h2:…","props":{…},"readOnly":false}
 *   응답  {"id":1,"ok":true,…} 또는 {"id":1,"ok":false,"error":"…","sqlState":"…"}
 * op: open · execute · fetch · closeCursor · cancel · close · ping. cancel · close는 실행 중인 쿼리를 기다리지 않는다. 시작하면 {"ready":true}를 한 번 보낸다.
 * 표준 입력이 닫히면(확장이 끝나면) 연결을 모두 닫고 끝난다 — H2 파일 잠금이 남지 않게.
 *
 * 연결마다 작업 스레드 하나(문장은 차례로), cancel은 읽는 스레드에서 바로 처리한다(실행 중인 Statement.cancel()).
 * 드라이버가 System.out에 쓰면 프로토콜이 깨지므로 System.out은 표준 오류로 돌린다.
 */
public final class JdbcBridge {
    private static PrintStream protocolOut;
    private static final Map<String, Conn> conns = new ConcurrentHashMap<>();
    private static final Map<String, ClassLoader> loaders = new ConcurrentHashMap<>();
    private static final AtomicInteger seq = new AtomicInteger();

    public static void main(String[] args) throws Exception {
        protocolOut = new PrintStream(new FileOutputStream(FileDescriptor.out), false, "UTF-8");
        System.setOut(System.err);
        send(obj("ready", true, "java", System.getProperty("java.version")));
        BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        String line;
        while ((line = in.readLine()) != null) {
            if (line.trim().isEmpty()) continue;
            final Map<String, Object> msg;
            try {
                msg = Json.object(line);
            } catch (RuntimeException e) {
                send(obj("id", null, "ok", false, "error", "Bad request: " + e.getMessage()));
                continue;
            }
            dispatch(msg);
        }
        for (Conn c : conns.values()) c.closeQuietly();
        System.exit(0);
    }

    private static void dispatch(Map<String, Object> msg) {
        Object id = msg.get("id");
        String op = str(msg.get("op"));
        try {
            switch (op) {
                case "ping":
                    reply(id, obj());
                    return;
                case "open":
                    // 연결은 시간이 걸릴 수 있다(원격 서버) — 읽는 스레드를 막지 않는다
                    new Thread(() -> run(id, () -> open(msg)), "bindb-open").start();
                    return;
                case "cancel": {
                    Conn c = conns.get(str(msg.get("conn")));
                    if (c != null) c.cancelRunning();
                    reply(id, obj());
                    return;
                }
                case "close": {
                    // 작업 스레드 줄에 세우지 않는다 — 실행 중인 쿼리가 끝날 때까지 닫기가 기다리게 된다.
                    // 실행 중인 문장을 취소하고 바로 닫는다(그 쿼리의 요청은 오류로 끝난다)
                    Conn c = conns.get(str(msg.get("conn")));
                    if (c != null) {
                        c.cancelRunning();
                        c.closeQuietly();
                    }
                    reply(id, obj());
                    return;
                }
                default: {
                    Conn c = conns.get(str(msg.get("conn")));
                    if (c == null) throw new IllegalStateException("This connection is closed.");
                    c.worker.execute(() -> run(id, () -> c.handle(op, msg)));
                }
            }
        } catch (Exception e) {
            fail(id, e);
        }
    }

    interface Job {
        Map<String, Object> call() throws Exception;
    }

    private static void run(Object id, Job job) {
        try {
            reply(id, job.call());
        } catch (Throwable e) {
            fail(id, e);
        }
    }

    private static Map<String, Object> open(Map<String, Object> msg) throws Exception {
        ClassLoader loader = loaderFor(list(msg.get("jars")));
        Driver driver = (Driver) Class.forName(str(msg.get("driver")), true, loader).getDeclaredConstructor().newInstance();
        Properties props = new Properties();
        Object p = msg.get("props");
        if (p instanceof Map) for (Map.Entry<?, ?> e : ((Map<?, ?>) p).entrySet()) if (e.getValue() != null) props.setProperty(String.valueOf(e.getKey()), String.valueOf(e.getValue()));
        // DriverManager 대신 드라이버를 직접 부른다 — 따로 불러온 클래스 로더의 드라이버는 DriverManager가 보지 못한다
        Connection c = driver.connect(str(msg.get("url")), props);
        if (c == null) throw new SQLException("The driver does not accept this URL: " + msg.get("url"));
        if (Boolean.TRUE.equals(msg.get("readOnly"))) {
            try {
                c.setReadOnly(true);
            } catch (SQLException ignored) {
                // 읽기 전용 힌트를 모르는 드라이버
            }
        }
        String id = "c" + seq.incrementAndGet();
        conns.put(id, new Conn(id, c));
        DatabaseMetaData md = c.getMetaData();
        return obj("conn", id, "product", md.getDatabaseProductName(), "version", md.getDatabaseProductVersion());
    }

    /** 같은 jar 목록이면 클래스 로더를 함께 쓴다(드라이버 클래스를 한 번만 불러온다) */
    private static ClassLoader loaderFor(List<Object> jars) throws Exception {
        String key = String.valueOf(jars);
        ClassLoader cached = loaders.get(key);
        if (cached != null) return cached;
        URL[] urls = new URL[jars.size()];
        for (int i = 0; i < urls.length; i++) {
            File f = new File(String.valueOf(jars.get(i)));
            if (!f.isFile()) throw new IllegalArgumentException("Driver file not found: " + f);
            urls[i] = f.toURI().toURL();
        }
        ClassLoader loader = new URLClassLoader(urls, JdbcBridge.class.getClassLoader());
        loaders.put(key, loader);
        return loader;
    }

    /** 연결 하나: 작업 스레드 · 열린 결과 · 실행 중인 문장 */
    static final class Conn {
        final String id;
        final Connection connection;
        final ExecutorService worker;
        // 작업 스레드와 읽는 스레드(close)가 함께 만진다
        final Map<String, Cursor> cursors = new ConcurrentHashMap<>();
        volatile Statement running;

        Conn(String id, Connection connection) {
            this.id = id;
            this.connection = connection;
            this.worker = Executors.newSingleThreadExecutor(r -> {
                Thread t = new Thread(r, "bindb-" + id);
                t.setDaemon(true);
                return t;
            });
        }

        Map<String, Object> handle(String op, Map<String, Object> msg) throws Exception {
            switch (op) {
                case "execute":
                    return execute(str(msg.get("sql")), list(msg.get("params")), num(msg.get("fetch"), 200));
                case "fetch": {
                    Cursor cur = cursors.get(str(msg.get("cursor")));
                    if (cur == null) throw new IllegalStateException("This result was closed.");
                    return rows(cur, num(msg.get("n"), 200));
                }
                case "closeCursor": {
                    Cursor cur = cursors.remove(str(msg.get("cursor")));
                    if (cur != null) cur.close();
                    return obj();
                }
                default:
                    throw new IllegalArgumentException("Unknown op: " + op);
            }
        }

        Map<String, Object> execute(String sql, List<Object> params, int fetch) throws Exception {
            Statement st;
            boolean hasResult;
            if (params.isEmpty()) {
                st = connection.createStatement();
                running = st;
                try {
                    hasResult = st.execute(sql);
                } finally {
                    running = null;
                }
            } else {
                PreparedStatement ps = connection.prepareStatement(sql);
                for (int i = 0; i < params.size(); i++) ps.setObject(i + 1, params.get(i));
                st = ps;
                running = st;
                try {
                    hasResult = ps.execute();
                } finally {
                    running = null;
                }
            }
            if (!hasResult) {
                int count = st.getUpdateCount();
                st.close();
                return obj("columns", new ArrayList<>(), "affected", count < 0 ? null : count, "done", true);
            }
            st.setFetchSize(fetch);
            Cursor cur = new Cursor("q" + seq.incrementAndGet(), st, st.getResultSet());
            Map<String, Object> out = rows(cur, fetch);
            out.put("columns", cur.columns());
            if (Boolean.FALSE.equals(out.get("done"))) {
                cursors.put(cur.id, cur);
                out.put("cursor", cur.id);
            }
            return out;
        }

        Map<String, Object> rows(Cursor cur, int n) throws Exception {
            List<Object> rows = new ArrayList<>();
            boolean done = false;
            running = cur.statement;
            try {
                while (rows.size() < n) {
                    if (!cur.rs.next()) {
                        done = true;
                        break;
                    }
                    rows.add(cur.row());
                }
            } finally {
                running = null;
            }
            if (done) {
                cursors.remove(cur.id);
                cur.close();
            }
            return obj("rows", rows, "done", done);
        }

        void cancelRunning() {
            Statement st = running;
            if (st == null) return;
            try {
                st.cancel();
            } catch (SQLException ignored) {
                // 취소를 모르는 드라이버
            }
        }

        void closeQuietly() {
            conns.remove(id);
            for (Cursor c : cursors.values()) c.close();
            cursors.clear();
            try {
                connection.close();
            } catch (SQLException ignored) {
                // 이미 끊긴 연결
            }
            worker.shutdown();
        }
    }

    /** 열린 결과 하나. 값은 JSON으로 손실 없이 보낼 수 있는 모양으로 바꾼다 */
    static final class Cursor {
        final String id;
        final Statement statement;
        final ResultSet rs;
        final int[] types;
        final String[] names;
        final String[] typeNames;

        Cursor(String id, Statement statement, ResultSet rs) throws SQLException {
            this.id = id;
            this.statement = statement;
            this.rs = rs;
            ResultSetMetaData md = rs.getMetaData();
            int n = md.getColumnCount();
            types = new int[n];
            names = new String[n];
            typeNames = new String[n];
            for (int i = 0; i < n; i++) {
                types[i] = md.getColumnType(i + 1);
                names[i] = md.getColumnLabel(i + 1);
                typeNames[i] = md.getColumnTypeName(i + 1);
            }
        }

        List<Object> columns() {
            List<Object> out = new ArrayList<>();
            for (int i = 0; i < names.length; i++) out.add(obj("name", names[i], "type", typeNames[i]));
            return out;
        }

        /**
         * 정수(32비트까지) · 실수 · 참거짓은 JSON 값으로, 큰 정수 · DECIMAL은 글자로(정밀도),
         * 바이너리는 base64로, 날짜 · 시각 · 배열 · 그 밖의 타입은 드라이버가 주는 글자 그대로(시간대 · 마이크로초 보존).
         */
        List<Object> row() throws SQLException {
            List<Object> out = new ArrayList<>(types.length);
            for (int i = 0; i < types.length; i++) {
                int c = i + 1;
                Object v;
                switch (types[i]) {
                    case Types.BIT:
                    case Types.BOOLEAN:
                        v = rs.getBoolean(c);
                        break;
                    case Types.TINYINT:
                    case Types.SMALLINT:
                    case Types.INTEGER:
                        v = rs.getInt(c);
                        break;
                    case Types.REAL:
                    case Types.FLOAT:
                    case Types.DOUBLE: {
                        double d = rs.getDouble(c);
                        v = Double.isFinite(d) ? (Object) d : String.valueOf(d);
                        break;
                    }
                    case Types.BINARY:
                    case Types.VARBINARY:
                    case Types.LONGVARBINARY:
                    case Types.BLOB: {
                        // H2는 UUID를 JDBC 타입 BINARY로 알린다 — 글자로 보낸다
                        if ("UUID".equalsIgnoreCase(typeNames[i])) {
                            v = rs.getString(c);
                            break;
                        }
                        byte[] b = rs.getBytes(c);
                        v = b == null ? null : obj("$b64", Base64.getEncoder().encodeToString(b));
                        break;
                    }
                    default:
                        v = rs.getString(c);
                }
                out.add(rs.wasNull() ? null : v);
            }
            return out;
        }

        void close() {
            try {
                statement.close();
            } catch (SQLException ignored) {
                // 이미 닫힘
            }
        }
    }

    // ── 응답 ──

    private static void reply(Object id, Map<String, Object> body) {
        Map<String, Object> out = obj("id", id, "ok", true);
        out.putAll(body);
        send(out);
    }

    private static void fail(Object id, Throwable e) {
        Map<String, Object> out = obj("id", id, "ok", false, "error", e.getMessage() != null ? e.getMessage() : e.toString());
        if (e instanceof SQLException) {
            out.put("sqlState", ((SQLException) e).getSQLState());
            out.put("code", ((SQLException) e).getErrorCode());
        }
        send(out);
    }

    private static synchronized void send(Map<String, Object> msg) {
        try {
            Writer w = new OutputStreamWriter(protocolOut, StandardCharsets.UTF_8);
            StringBuilder sb = new StringBuilder();
            Json.write(sb, msg);
            sb.append('\n');
            w.write(sb.toString());
            w.flush();
        } catch (Exception e) {
            System.err.println("bindb: cannot write a response: " + e);
        }
    }

    // ── 작은 도우미 ──

    static Map<String, Object> obj(Object... kv) {
        Map<String, Object> m = new LinkedHashMap<>();
        for (int i = 0; i + 1 < kv.length; i += 2) m.put(String.valueOf(kv[i]), kv[i + 1]);
        return m;
    }

    static String str(Object o) {
        return o == null ? "" : String.valueOf(o);
    }

    @SuppressWarnings("unchecked")
    static List<Object> list(Object o) {
        return o instanceof List ? (List<Object>) o : new ArrayList<>();
    }

    static int num(Object o, int fallback) {
        return o instanceof Number ? ((Number) o).intValue() : fallback;
    }

    /** JSON 읽기 · 쓰기(표준 라이브러리만). 숫자는 정수면 Long, 아니면 BigDecimal */
    static final class Json {
        private final String s;
        private int i;

        private Json(String s) {
            this.s = s;
        }

        @SuppressWarnings("unchecked")
        static Map<String, Object> object(String text) {
            Json p = new Json(text);
            Object v = p.value();
            p.space();
            if (p.i != text.length() || !(v instanceof Map)) throw new IllegalArgumentException("expected one JSON object");
            return (Map<String, Object>) v;
        }

        private void space() {
            while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++;
        }

        private Object value() {
            space();
            if (i >= s.length()) throw new IllegalArgumentException("unexpected end");
            char c = s.charAt(i);
            if (c == '{') {
                i++;
                Map<String, Object> m = new LinkedHashMap<>();
                space();
                if (peek('}')) return m;
                do {
                    space();
                    String k = string();
                    space();
                    expect(':');
                    m.put(k, value());
                    space();
                } while (take(','));
                expect('}');
                return m;
            }
            if (c == '[') {
                i++;
                List<Object> l = new ArrayList<>();
                space();
                if (peek(']')) return l;
                do {
                    l.add(value());
                    space();
                } while (take(','));
                expect(']');
                return l;
            }
            if (c == '"') return string();
            if (s.startsWith("true", i)) {
                i += 4;
                return Boolean.TRUE;
            }
            if (s.startsWith("false", i)) {
                i += 5;
                return Boolean.FALSE;
            }
            if (s.startsWith("null", i)) {
                i += 4;
                return null;
            }
            int start = i;
            while (i < s.length() && "+-0123456789.eE".indexOf(s.charAt(i)) >= 0) i++;
            String n = s.substring(start, i);
            if (n.isEmpty()) throw new IllegalArgumentException("unexpected '" + c + "'");
            if (n.indexOf('.') < 0 && n.indexOf('e') < 0 && n.indexOf('E') < 0 && n.length() < 19) return Long.parseLong(n);
            return new BigDecimal(n);
        }

        private String string() {
            expect('"');
            StringBuilder sb = new StringBuilder();
            while (true) {
                if (i >= s.length()) throw new IllegalArgumentException("unterminated string");
                char c = s.charAt(i++);
                if (c == '"') return sb.toString();
                if (c != '\\') {
                    sb.append(c);
                    continue;
                }
                char e = s.charAt(i++);
                switch (e) {
                    case 'n': sb.append('\n'); break;
                    case 't': sb.append('\t'); break;
                    case 'r': sb.append('\r'); break;
                    case 'b': sb.append('\b'); break;
                    case 'f': sb.append('\f'); break;
                    case 'u':
                        sb.append((char) Integer.parseInt(s.substring(i, i + 4), 16));
                        i += 4;
                        break;
                    default: sb.append(e);
                }
            }
        }

        private boolean peek(char c) {
            if (i < s.length() && s.charAt(i) == c) {
                i++;
                return true;
            }
            return false;
        }

        private boolean take(char c) {
            space();
            return peek(c);
        }

        private void expect(char c) {
            space();
            if (i >= s.length() || s.charAt(i) != c) throw new IllegalArgumentException("expected '" + c + "' at " + i);
            i++;
        }

        static void write(StringBuilder sb, Object v) {
            if (v == null) sb.append("null");
            else if (v instanceof String) quote(sb, (String) v);
            else if (v instanceof Boolean || v instanceof Integer || v instanceof Long) sb.append(v);
            else if (v instanceof Double) sb.append(((Double) v).toString());
            else if (v instanceof Number) quote(sb, v.toString());
            else if (v instanceof Map) {
                sb.append('{');
                boolean first = true;
                for (Map.Entry<?, ?> e : ((Map<?, ?>) v).entrySet()) {
                    if (!first) sb.append(',');
                    first = false;
                    quote(sb, String.valueOf(e.getKey()));
                    sb.append(':');
                    write(sb, e.getValue());
                }
                sb.append('}');
            } else if (v instanceof List) {
                sb.append('[');
                boolean first = true;
                for (Object o : (List<?>) v) {
                    if (!first) sb.append(',');
                    first = false;
                    write(sb, o);
                }
                sb.append(']');
            } else quote(sb, v.toString());
        }

        private static void quote(StringBuilder sb, String s) {
            sb.append('"');
            for (int k = 0; k < s.length(); k++) {
                char c = s.charAt(k);
                switch (c) {
                    case '"': sb.append("\\\""); break;
                    case '\\': sb.append("\\\\"); break;
                    case '\n': sb.append("\\n"); break;
                    case '\r': sb.append("\\r"); break;
                    case '\t': sb.append("\\t"); break;
                    default:
                        if (c < 0x20 || c == 0x2028 || c == 0x2029) sb.append(String.format("\\u%04x", (int) c));
                        else sb.append(c);
                }
            }
            sb.append('"');
        }
    }
}
