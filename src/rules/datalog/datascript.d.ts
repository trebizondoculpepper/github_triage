/** Minimal TypeScript boundary for the pinned DataScript dependency. */
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
