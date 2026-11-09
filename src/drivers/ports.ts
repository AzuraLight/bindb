import type { DriverId } from './types';

/** 드라이버별 기본 포트(SSH 터널 목적지를 정할 때) */
export const DEFAULT_PORTS: Partial<Record<DriverId, number>> = { postgres: 5432, mysql: 3306, h2: 9092 };
