// Fast drop-in for csv-reader 1.0.0 (make.fun's own CSV reader).
// Returns exactly what readCsv returns for {text, header} -> {columns, rows, errors}.
// Single pass, no dependencies. Strategy: never build a field character by
// character. Unquoted fields are located with native indexOf (',' / LF) and cut
// with one slice; a CR inside the slice is handled on the rare path only.
// Quoted fields jump from quote to quote with indexOf('"'); segments between
// quotes are sliced whole, and only segments holding CR/LF are walked.
// Semantics follow vendor/csv-reader/index.js exactly (see RULES.txt).

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // next character to read
  let line = 1; // line that character is on
  if (len > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes.
  let recordLine = 1;
  let recordRow = null;

  // Appends `seg` (a slice from inside a quoted field) to `value`, counting
  // lines and reading each CRLF / lone CR inside it as one LF.
  function addSegment(value, seg) {
    if (seg.indexOf('\n') === -1 && seg.indexOf('\r') === -1) return value + seg;
    let out = value;
    let p = 0;
    for (;;) {
      const iN = seg.indexOf('\n', p);
      const iR = seg.indexOf('\r', p);
      let i = -1;
      let cr = false;
      if (iN !== -1) i = iN;
      if (iR !== -1 && (i === -1 || iR < i)) {
        i = iR;
        cr = true;
      }
      if (i === -1) {
        out += seg.slice(p);
        break;
      }
      out += seg.slice(p, i);
      out += '\n';
      line += 1;
      p = cr && seg.charCodeAt(i + 1) === 10 ? i + 2 : i + 1;
    }
    return out;
  }

  // Reads unquoted characters onto `value` up to the next comma or line break.
  // A CR not followed by LF is dropped (stray_cr). Returns the field and how
  // it ended; `added` counts the characters kept (not the incoming `value`).
  function readUnquoted(value) {
    let added = 0;
    for (;;) {
      const iC = text.indexOf(',', pos);
      const iN = text.indexOf('\n', pos);
      let i = -1;
      let comma = false;
      if (iC !== -1 && (iN === -1 || iC < iN)) {
        i = iC;
        comma = true;
      } else if (iN !== -1) {
        i = iN;
      }
      if (i === -1) {
        // No comma or LF ahead: the field runs to the end of the text.
        // Every CR in it is stray (no LF follows one here).
        const v = text.slice(pos);
        const k = v.indexOf('\r');
        if (k === -1) {
          value += v;
          added += v.length;
          pos = len;
          return { value, ended: END, added };
        }
        let p = 0;
        for (;;) {
          const r = v.indexOf('\r', p);
          if (r === -1) {
            value += v.slice(p);
            added += v.length - p;
            break;
          }
          value += v.slice(p, r);
          added += r - p;
          errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
          p = r + 1;
        }
        pos = len;
        return { value, ended: END, added };
      }
      // The field's next stretch is [pos, i); a CR inside it decides the end.
      const v = text.slice(pos, i);
      const j = v.indexOf('\r');
      if (j === -1) {
        value += v;
        added += v.length;
        pos = i + 1;
        if (comma) return { value, ended: COMMA, added };
        line += 1;
        return { value, ended: LINE_BREAK, added };
      }
      if (text.charCodeAt(pos + j + 1) === 10) {
        // CRLF: the field ends at the CR (i is the LF right after it).
        value += v.slice(0, j);
        added += j;
        pos = i + 1;
        line += 1;
        return { value, ended: LINE_BREAK, added };
      }
      // Stray CR: drop it, report it, and keep reading the same field.
      value += v.slice(0, j);
      added += j;
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      pos = pos + j + 1;
    }
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let value = '';
    let cur = pos + 1;
    for (;;) {
      const q = text.indexOf('"', cur);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as unquoted.
        pos = open + 1;
        line = openLine;
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        return readUnquoted('"');
      }
      if (text.charCodeAt(q + 1) === 34) {
        // Doubled quote: one literal quote, keep reading the field.
        value = addSegment(value, text.slice(cur, q));
        value += '"';
        cur = q + 2;
        continue;
      }
      value = addSegment(value, text.slice(cur, q));
      pos = q + 1;
      if (pos >= len) return { value, ended: END, added: 0 };
      const c = text.charCodeAt(pos);
      if (c === 44) {
        pos += 1;
        return { value, ended: COMMA, added: 0 };
      }
      if (c === 10) {
        pos += 1;
        line += 1;
        return { value, ended: LINE_BREAK, added: 0 };
      }
      if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
        return { value, ended: LINE_BREAK, added: 0 };
      }
      // What follows the closing quote is appended as it stands, up to the
      // next comma or line break.
      const junk = readUnquoted(value);
      if (junk.added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
      return junk;
    }
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // FAST PATH: a record with no quote at all. Its next line break ends it
    // (no quoted field can span lines), it holds no CR except a trailing
    // one of a CRLF, and its fields are one native split(',') apart. Any
    // quote, or any other CR, falls through to the exact slow path below.
    let fields = null;
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? len : nl;
    const seg = text.slice(pos, end);
    if (seg.indexOf('"') === -1) {
      let s = seg;
      if (nl !== -1 && s.charCodeAt(s.length - 1) === 13) s = s.slice(0, -1);
      if (s.indexOf('\r') === -1) {
        fields = s.split(',');
        pos = nl === -1 ? len : nl + 1;
        line += 1;
      }
    }
    if (fields === null) {
      fields = [];
      let field;
      let quoted;
      do {
        quoted = text.charCodeAt(pos) === 34;
        field = quoted ? readQuoted() : readUnquoted('');
        fields.push(field.value);
      } while (field.ended === COMMA);

      // A line that held only stray CRs is left with no characters: no record
      // (its stray_cr errors stay).
      if (fields.length === 1 && fields[0] === '' && !quoted) continue;
    }

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
