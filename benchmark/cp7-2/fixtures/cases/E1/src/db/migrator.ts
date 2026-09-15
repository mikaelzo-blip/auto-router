export interface ColumnDef {
  name: string;
  type: string;
  nullable: boolean;
  defaultValue?: any;
}

export interface TableDef {
  name: string;
  columns: Map<string, ColumnDef>;
  rows: Array<Record<string, any>>;
}

export class InMemoryDatabase {
  public tables: Map<string, TableDef> = new Map();

  public createTable(name: string, columns: ColumnDef[], initialRows: Array<Record<string, any>> = []): void {
    const colMap = new Map<string, ColumnDef>();
    for (const c of columns) {
      colMap.set(c.name, c);
    }
    this.tables.set(name, {
      name,
      columns: colMap,
      rows: initialRows.map(r => ({ ...r }))
    });
  }

  public getTable(name: string): TableDef | undefined {
    return this.tables.get(name);
  }
}

export class SchemaMigrator {
  private readonly db: InMemoryDatabase;

  constructor(db: InMemoryDatabase) {
    this.db = db;
  }

  public addColumnUnsafe(tableName: string, col: ColumnDef): void {
    const table = this.db.getTable(tableName);
    if (!table) throw new Error(`Table ${tableName} not found`);

    // NAIVE / DEFECTIVE IMPLEMENTATION:
    // If not null and existing rows exist without default, setting not null immediately causes constraint violation
    if (!col.nullable && table.rows.length > 0 && col.defaultValue === undefined) {
      throw new Error(`Cannot add NOT NULL column ${col.name} to non-empty table ${tableName}`);
    }

    table.columns.set(col.name, col);
    for (const row of table.rows) {
      row[col.name] = col.defaultValue ?? null;
    }
  }

  // Required 3-phase safe migration methods to be implemented:
  public addNullableColumn(tableName: string, colName: string, type: string): void {
    const table = this.db.getTable(tableName);
    if (!table) throw new Error(`Table ${tableName} not found`);
    table.columns.set(colName, { name: colName, type, nullable: true });
    for (const row of table.rows) {
      if (row[colName] === undefined) {
        row[colName] = null;
      }
    }
  }

  public backfillColumn(tableName: string, colName: string, resolver: (row: Record<string, any>) => any): void {
    const table = this.db.getTable(tableName);
    if (!table) throw new Error(`Table ${tableName} not found`);
    for (const row of table.rows) {
      if (row[colName] === null || row[colName] === undefined) {
        row[colName] = resolver(row);
      }
    }
  }

  public setNotNullConstraint(tableName: string, colName: string): void {
    const table = this.db.getTable(tableName);
    if (!table) throw new Error(`Table ${tableName} not found`);
    const col = table.columns.get(colName);
    if (!col) throw new Error(`Column ${colName} not found`);

    // Incomplete: does not verify all existing rows are non-null before applying constraint!
    col.nullable = false;
  }
}
