/**
 * Parse MySQL/phpMyAdmin INSERT dumps into row objects.
 */

function parseSqlValue(raw) {
  const v = raw.trim()
  if (v.toUpperCase() === 'NULL') return null
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v)
  if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) {
    const quote = v[0]
    let out = ''
    for (let i = 1; i < v.length - 1; i++) {
      const c = v[i]
      if (c === '\\' && i + 1 < v.length - 1) {
        const next = v[i + 1]
        if (next === 'n') out += '\n'
        else if (next === 'r') out += '\r'
        else if (next === 't') out += '\t'
        else out += next
        i++
        continue
      }
      if (c === quote && v[i + 1] === quote) {
        out += quote
        i++
        continue
      }
      out += c
    }
    return out
  }
  return v
}

function splitSqlTuple(inner) {
  const values = []
  let current = ''
  let inString = false
  let stringQuote = null

  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]

    if (inString) {
      current += c
      if (c === '\\' && i + 1 < inner.length) {
        current += inner[i + 1]
        i++
        continue
      }
      if (c === stringQuote) {
        if (inner[i + 1] === stringQuote) {
          current += inner[i + 1]
          i++
          continue
        }
        inString = false
        stringQuote = null
      }
      continue
    }

    if (c === "'" || c === '"') {
      inString = true
      stringQuote = c
      current += c
      continue
    }

    if (c === ',') {
      values.push(parseSqlValue(current))
      current = ''
      continue
    }

    current += c
  }

  if (current.length) values.push(parseSqlValue(current))
  return values
}

function extractInsertBlocks(sql, tableName) {
  const blocks = []
  const re = new RegExp(
    `INSERT\\s+INTO\\s+\`${tableName}\`\\s*\\([^)]+\\)\\s*VALUES\\s*`,
    'gi'
  )
  let match
  while ((match = re.exec(sql)) !== null) {
    let i = match.index + match[0].length
    let depth = 0
    let inString = false
    let stringQuote = null
    let buf = ''

    while (i < sql.length) {
      const c = sql[i]

      if (inString) {
        buf += c
        if (c === '\\' && i + 1 < sql.length) {
          buf += sql[i + 1]
          i++
        } else if (c === stringQuote) {
          if (sql[i + 1] === stringQuote) {
            buf += sql[i + 1]
            i++
          } else {
            inString = false
            stringQuote = null
          }
        }
        i++
        continue
      }

      if (c === "'" || c === '"') {
        inString = true
        stringQuote = c
        buf += c
        i++
        continue
      }

      if (c === '(') {
        depth++
        buf += c
        i++
        continue
      }

      if (c === ')') {
        depth--
        buf += c
        if (depth === 0) {
          blocks.push(buf)
          buf = ''
          i++
          while (i < sql.length && /[\s,]/.test(sql[i])) i++
          if (sql[i] === ';') break
          continue
        }
        i++
        continue
      }

      if (depth === 0 && c === ';') break

      if (depth > 0) buf += c
      i++
    }
  }
  return blocks
}

function parseInsertTuples(sql, tableName) {
  const blocks = extractInsertBlocks(sql, tableName)
  const tuples = []
  for (const block of blocks) {
    const inner = block.slice(1, -1)
    tuples.push(splitSqlTuple(inner))
  }
  return tuples
}

function mapRows(sql, tableName, columns) {
  return parseInsertTuples(sql, tableName).map((tuple) => {
    const row = {}
    columns.forEach((col, idx) => {
      row[col] = tuple[idx] ?? null
    })
    return row
  })
}

function parseDate(value) {
  if (!value || value === '0000-00-00' || value === '0000-00-00 00:00:00') return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

function normalizeBcryptHash(hash) {
  if (!hash) return hash
  return String(hash).replace(/^\$2y\$/, '$2a$')
}

module.exports = {
  parseInsertTuples,
  mapRows,
  parseDate,
  normalizeBcryptHash,
}
