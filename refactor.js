const fs = require('fs');
const path = require('path');

function processDir(dir) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      processDir(fullPath);
    } else if (fullPath.endsWith('.js') && !fullPath.includes('node_modules') && !fullPath.includes('db\\index.js')) {
      processFile(fullPath);
    }
  }
}

function processFile(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');
  let original = content;

  // Change router.*(..., (req, res) => to async
  content = content.replace(/(router\.[a-z]+\([^,]+,\s*(?:requireRole\([^)]+\),\s*)?)(?<!async\s+)(\(req,\s*res\)\s*=>)/g, '$1async $2');
  content = content.replace(/(router\.[a-z]+\([^,]+,\s*(?:requireRole\([^)]+\),\s*)?)(?<!async\s+)(\(req,\s*res,\s*next\)\s*=>)/g, '$1async $2');
  
  // Also handle simple router.get('/path', (req, res) => ...
  content = content.replace(/(router\.[a-z]+\([^,]+,\s*)(?<!async\s+)(\(req,\s*res\)\s*=>)/g, '$1async $2');
  
  // App.get/post in server.js
  content = content.replace(/(app\.[a-z]+\([^,]+,\s*)(?<!async\s+)(\(req,\s*res\)\s*=>)/g, '$1async $2');
  
  // Change db.prepare to await db.prepare
  content = content.replace(/db\.prepare\([\s\S]*?\)\.get\([\s\S]*?\)/g, match => {
    if (match.startsWith('await ')) return match;
    return `await ${match}`;
  });
  content = content.replace(/db\.prepare\([\s\S]*?\)\.all\([\s\S]*?\)/g, match => {
    if (match.startsWith('await ')) return match;
    return `await ${match}`;
  });
  content = content.replace(/db\.prepare\([\s\S]*?\)\.run\([\s\S]*?\)/g, match => {
    if (match.startsWith('await ')) return match;
    return `await ${match}`;
  });

  // Handle db.prepare without arguments in get/all/run
  content = content.replace(/db\.prepare\([\s\S]*?\)\.get\(\)/g, match => {
    if (match.startsWith('await ')) return match;
    return `await ${match}`;
  });
  content = content.replace(/db\.prepare\([\s\S]*?\)\.all\(\)/g, match => {
    if (match.startsWith('await ')) return match;
    return `await ${match}`;
  });
  content = content.replace(/db\.prepare\([\s\S]*?\)\.run\(\)/g, match => {
    if (match.startsWith('await ')) return match;
    return `await ${match}`;
  });

  // Also replace `.get().count` with `.get(); ... .count` if needed, but in async we might have `(await db.prepare().get()).count`.
  // Let's do a slightly safer replacement for chained properties:
  content = content.replace(/await db\.prepare\((.*?)\)\.get\((.*?)\)\.count/g, '(await db.prepare($1).get($2)).count');
  content = content.replace(/await db\.prepare\((.*?)\)\.get\(\)\.count/g, '(await db.prepare($1).get()).count');

  // Replace db.transaction
  content = content.replace(/db\.transaction\(\(\)\s*=>\s*\{/g, 'await db.transaction(async () => {');

  // Fix INSERT OR IGNORE and INSERT OR REPLACE
  content = content.replace(/INSERT OR IGNORE INTO/g, 'INSERT INTO');
  // Need to append ON CONFLICT DO NOTHING, but let's do it in the wrapper! 
  // Postgres actually supports doing this via SQL parsing in the wrapper!

  if (content !== original) {
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`Refactored: ${filePath}`);
  }
}

processDir(path.join(__dirname, 'src'));
