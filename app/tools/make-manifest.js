// node tools/make-manifest.js "бележки"  -> записва manifest.json с версията от package.json и SHA-256 на файловете
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const root = path.join(__dirname, '..');
const files = ['main.js', 'preload.js', 'package.json'];
for (const d of ['lib', 'renderer']) for (const f of fs.readdirSync(path.join(root, d))) if (/\.(js|html|css|json)$/.test(f)) files.push(d + '/' + f);
const man = { version: require(path.join(root, 'package.json')).version, notes: process.argv[2] || '', files: {} };
for (const f of files.sort()) man.files[f] = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, f))).digest('hex');
fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(man, null, 1));
console.log('manifest', man.version, Object.keys(man.files).length, 'файла');
