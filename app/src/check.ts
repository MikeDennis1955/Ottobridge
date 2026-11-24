import { readFileSync } from 'fs';
import { parseHand } from './parse';
import { validate, callText } from './rules';
for (const f of process.argv.slice(2)) {
  const r = parseHand(readFileSync(f, 'utf8'));
  const v = r.script ? validate(r.script) : null;
  console.log(`== ${f}`);
  r.errors.forEach(e => console.log('  PARSE', e.line ?? '', e.msg));
  v?.errors.forEach(e => console.log('  ERROR', e.msg));
  v?.warnings.forEach(e => console.log('  WARN ', e.msg));
  const c = v?.derived.contract;
  if (c) console.log(`  contract ${c.level}${c.strain}${c.doubled} by ${c.declarer}; declarer tricks ${v!.derived.declarerTricks}; trumps out ${v!.derived.trumpsOutstanding}`);
}
