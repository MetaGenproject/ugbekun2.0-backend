/**
 * Parse MySQL/phpMyAdmin INSERT dumps into row objects.
 */

export function parseSqlValue(raw: string): any {
  const v = raw.trim();
  if (v.toUpperCase() === 'NULL') return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) {
    const quote = v[0];
    let out = '';
    for (let i = 1; i < v.length - 1; i++) {
      const c = v[i];
      if (c === '\\' && i + 1 < v.length - 1) {
        const next = v[i + 1];
        if (next === 'n') out += '\n';
        else if (next === 'r') out += '\r';
        else if (next === 't') out += '\t';
        else out += next;
        i++;
        continue;
      }
      if (c === quote && v[i + 1] === quote) {
        out += quote;
        i++;
        continue;
      }
      out += c;
    }
    return out;
  }
  return v;
}

export function splitSqlTuple(inner: string): any[] {
  const values: any[] = [];
  let current = '';
  let inString = false;
  let stringQuote: string | null = null;

  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];

    if (inString) {
      current += c;
      if (c === '\\' && i + 1 < inner.length) {
        current += inner[i + 1];
        i++;
        continue;
      }
      if (c === stringQuote) {
        if (inner[i + 1] === stringQuote) {
          current += inner[i + 1];
          i++;
          continue;
        }
        inString = false;
        stringQuote = null;
      }
      continue;
    }

    if (c === "'" || c === '"') {
      inString = true;
      stringQuote = c;
      current += c;
      continue;
    }

    if (c === ',') {
      values.push(parseSqlValue(current));
      current = '';
      continue;
    }

    current += c;
  }

  if (current.length) values.push(parseSqlValue(current));
  return values;
}

export function extractInsertBlocks(sql: string, tableName: string): string[] {
  const blocks: string[] = [];
  const re = new RegExp(
    `INSERT\\s+INTO\\s+\`${tableName}\`\\s*\\([^)]+\\)\\s*VALUES\\s*`,
    'gi'
  );
  let match: RegExpExecArray | null;
  while ((match = re.exec(sql)) !== null) {
    let i = match.index + match[0].length;
    let depth = 0;
    let inString = false;
    let stringQuote: string | null = null;
    let buf = '';

    while (i < sql.length) {
      const c = sql[i];

      if (inString) {
        buf += c;
        if (c === '\\' && i + 1 < sql.length) {
          buf += sql[i + 1];
          i++;
        } else if (c === stringQuote) {
          if (sql[i + 1] === stringQuote) {
            buf += sql[i + 1];
            i++;
          } else {
            inString = false;
            stringQuote = null;
          }
        }
        i++;
        continue;
      }

      if (c === "'" || c === '"') {
        inString = true;
        stringQuote = c;
        buf += c;
        i++;
        continue;
      }

      if (c === '(') {
        depth++;
        buf += c;
        i++;
        continue;
      }

      if (c === ')') {
        depth--;
        buf += c;
        if (depth === 0) {
          blocks.push(buf);
          buf = '';
          i++;
          while (i < sql.length && /[\s,]/.test(sql[i])) i++;
          if (sql[i] === ';') break;
          continue;
        }
        i++;
        continue;
      }

      if (depth === 0 && c === ';') break;

      if (depth > 0) buf += c;
      i++;
    }
  }
  return blocks;
}

export function parseInsertTuples(sql: string, tableName: string): any[][] {
  const blocks = extractInsertBlocks(sql, tableName);
  const tuples: any[][] = [];
  for (const block of blocks) {
    const inner = block.slice(1, -1);
    tuples.push(splitSqlTuple(inner));
  }
  return tuples;
}

export function mapRows(sql: string, tableName: string, columns: string[]): Array<Record<string, any>> {
  return parseInsertTuples(sql, tableName).map((tuple) => {
    const row: Record<string, any> = {};
    columns.forEach((col, idx) => {
      row[col] = tuple[idx] ?? null;
    });
    return row;
  });
}

export function parseDate(value: any): Date | null {
  if (!value || value === '0000-00-00' || value === '0000-00-00 00:00:00') return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function normalizeBcryptHash(hash?: string | null): string | null | undefined {
  if (!hash) return hash;
  return String(hash).replace(/^\$2y\$/, '$2a$');
}

export default {
  parseInsertTuples,
  mapRows,
  parseDate,
  normalizeBcryptHash,
};
