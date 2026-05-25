const fs = require('fs');
const path = require('path');

const sqlFilePath = path.join(__dirname, '..', 'ugbekunc_Saas (2).sql');

function parseTuple(line) {
  let str = line.trim();
  if (str.endsWith(',')) str = str.slice(0, -1);
  if (str.endsWith(';')) str = str.slice(0, -1);
  if (str.startsWith('(') && str.endsWith(')')) {
    str = str.slice(1, -1);
  } else {
    return null;
  }

  const values = [];
  let currentVal = '';
  let inString = false;
  let quoteChar = null;
  let escaped = false;

  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    if (escaped) {
      currentVal += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (inString) {
      if (char === quoteChar) {
        inString = false;
      } else {
        currentVal += char;
      }
    } else {
      if (char === "'" || char === '"') {
        inString = true;
        quoteChar = char;
      } else if (char === ',') {
        values.push(currentVal.trim());
        currentVal = '';
      } else {
        currentVal += char;
      }
    }
  }
  values.push(currentVal.trim());
  return values;
}

async function main() {
  console.log('Reading SQL dump...');
  const sql = fs.readFileSync(sqlFilePath, 'utf8');
  const lines = sql.split('\n');

  console.log(`Total lines in SQL file: ${lines.length}`);

  let inLoginCredential = false;
  const parsedRecords = [];
  const usernames = new Map();

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.includes("INSERT INTO `login_credential`")) {
      inLoginCredential = true;
      continue;
    }
    if (inLoginCredential) {
      if (trimmed.startsWith('(')) {
        const parsed = parseTuple(trimmed);
        if (parsed && parsed.length >= 9) {
          parsedRecords.push(parsed);
          const username = parsed[2];
          if (!usernames.has(username)) {
            usernames.set(username, []);
          }
          usernames.get(username).push(parsed);
        }
        if (trimmed.endsWith(';')) {
          inLoginCredential = false;
        }
      } else {
        inLoginCredential = false;
      }
    }
  }

  console.log(`Parsed ${parsedRecords.length} records from SQL dump.`);
  
  // Find duplicates
  const duplicates = [];
  for (const [username, list] of usernames.entries()) {
    if (list.length > 1) {
      duplicates.push({ username, count: list.length, items: list.map(item => ({ id: item[0], role: item[4] })) });
    }
  }

  console.log(`Unique usernames: ${usernames.size}`);
  console.log(`Duplicate usernames: ${duplicates.length}`);
  console.log('Duplicates summary:', JSON.stringify(duplicates.slice(0, 10), null, 2));
}

main();
