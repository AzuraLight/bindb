import { h2Driver } from './h2';
import { mysqlDriver } from './mysql';
import { postgresDriver } from './postgres';
import { sqliteDriver } from './sqlite';
import type { Driver, DriverId } from './types';

export const drivers: Record<DriverId, Driver> = {
  postgres: postgresDriver,
  mysql: mysqlDriver,
  sqlite: sqliteDriver,
  h2: h2Driver,
};

export * from './types';
