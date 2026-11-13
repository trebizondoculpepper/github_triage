/**
 * Minimal local declaration for the `datascript` package used by these examples (#74).
 *
 * datascript is deliberately NOT a project dependency: it is installed ad hoc, only to run the
 * examples, with `npm install --ignore-scripts --no-save datascript@1.8.1`. This file types just
 * the functions the examples call so they type-check without it installed.
 */
declare module "datascript" {
  /** An opaque DataScript database value. */
  export interface Db {
    readonly __datascriptDb: unique symbol;
  }
  /** An opaque DataScript connection. */
  export interface Conn {
    readonly __datascriptConn: unique symbol;
  }
  export type Value = string | number | boolean;
  export type Datom = [number, string, Value];
  export type Schema = Record<string, Record<string, string>>;
  export interface DataScript {
    q(query: string, db: Db, ...inputs: unknown[]): Value[][];
    init_db(datoms: Datom[], schema?: Schema): Db;
    create_conn(schema?: Schema): Conn;
    transact(conn: Conn, tx: [string, number, string, Value][]): unknown;
    db(conn: Conn): Db;
  }
  const ds: DataScript;
  export default ds;
}
