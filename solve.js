// Fast drop-in for csv-reader 1.0.0 (make.fun's own CSV reader).
//
// run(input) returns exactly csv-reader 1.0.0's answer for {text, header}:
// {columns, rows, errors}. Same reading policy, one pass, left to right:
// a U+FEFF at the very start is dropped; a record ends at LF or CRLF and an
// empty line is no record; a CR outside quotes not followed by LF is dropped
// (stray_cr); a field opening with a quote runs to the next undoubled quote
// ("" inside is one quote, CRLF or lone CR inside reads as LF); what follows
// the closing quote up to the next comma or line break is appended as it
// stands (quote_junk, when the field ends); a quote that never closes is a
// literal and the text after it is read again as unquoted
// (unterminated_quote); a quote inside an unquoted field is literal; fields
// stay strings. columns is the first record when header is true, else null;
// rows are padded (short_row) or cut (long_row) to the first record's width.
// Each error is {code, line, row} in the order met, line the 1-based line its
// record starts on, row its record's index in rows (null for the header).
//
// Speed: no per-character loop. An unquoted field is read by one sticky
// regex exec that consumes a whole plain run and stops at the first special
// character (no over-scan past the field's end); a quoted field the same way.
// A plain record (no quote, no CR before its line break) is one split(',')
// of the line. Deterministic: no clock, no randomness, no network, nothing
// kept from one call to the next.

// Sticky regexes: one exec consumes a whole plain run, stopping at the first
// special character (no over-scan past the field's end). Module-level: run()
// is synchronous, and lastIndex is set before every exec.
const PLAIN_RUN = /[^,\r\n]+/y;
const QUOTED_RUN = /[^"\r\n]+/y;

// How a field ended: at a comma (the record goes on), at a line break, or at
// the end of the text (the record ends).
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

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (len > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it
  // takes (null: the header). Every error of the record carries these.
  let recordLine = 1;
  let recordRow = null;

  // Reads unquoted characters onto `value` up to the next comma or line
  // break: a CR not followed by LF is dropped (stray_cr). Returns the field
  // and how it ended; `added` counts the characters kept.
  function readUnquoted(value) {
    let added = 0;
    for (;;) {
      PLAIN_RUN.lastIndex = pos;
      const m = PLAIN_RUN.exec(text);
      if (m !== null) {
        if (value === '') value = m[0];
        else value += m[0];
        added += m[0].length;
        pos = PLAIN_RUN.lastIndex;
      }
      if (pos >= len) return { value, ended: END, added };
      const c = text.charCodeAt(pos);
      if (c === 44) {
        pos += 1;
        return { value, ended: COMMA, added };
      }
      if (c === 10) {
        pos += 1;
        line += 1;
        return { value, ended: LINE_BREAK, added };
      }
      // A CR: CRLF ends the record, a lone CR is dropped (stray_cr).
      if (pos + 1 < len && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
        return { value, ended: LINE_BREAK, added };
      }
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      pos += 1;
    }
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let value = '';
    pos += 1;
    let closed = false;
    for (;;) {
      QUOTED_RUN.lastIndex = pos;
      const m = QUOTED_RUN.exec(text);
      if (m !== null) {
        if (value === '') value = m[0];
        else value += m[0];
        pos = QUOTED_RUN.lastIndex;
      }
      if (pos >= len) break;
      const c = text.charCodeAt(pos);
      if (c === 34) {
        if (pos + 1 < len && text.charCodeAt(pos + 1) === 34) {
          value += '"';
          pos += 2;
          continue;
        }
        pos += 1;
        closed = true;
        break;
      }
      if (c === 13) {
        // CRLF and a lone CR inside quotes are each one LF.
        value += '\n';
        line += 1;
        pos = pos + 1 < len && text.charCodeAt(pos + 1) === 10 ? pos + 2 : pos + 1;
        continue;
      }
      value += '\n';
      line += 1;
      pos += 1;
    }
    if (!closed) {
      // The quote never closes: it is a literal character, and the text
      // after it is read again as unquoted.
      pos = open + 1;
      line = openLine;
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      return readUnquoted('"');
    }
    if (pos >= len) return { value, ended: END };
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      return { value, ended: COMMA };
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      return { value, ended: LINE_BREAK };
    }
    if (c === 13 && pos + 1 < len && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      return { value, ended: LINE_BREAK };
    }
    // What follows the closing quote is appended as it stands, up to the
    // next comma or line break.
    const junk = readUnquoted(value);
    if (junk.added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    return junk;
  }

  // Finishes a record: sets the width from the first record, takes the
  // header, or pads/cuts the row to the width (short_row/long_row) and
  // pushes it. No field error can occur here; those are already recorded.
  function finishRecord(fields) {
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && pos + 1 < len && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Fast path: a plain record holds no quote and no CR before its line
    // break, so its fields are one split(',') of the line. No field error
    // can occur in it; only a short or long row.
    const nl = text.indexOf('\n', pos);
    const recEnd = nl < 0 ? len : nl;
    let contentEnd = recEnd;
    if (nl >= 0 && contentEnd > pos && text.charCodeAt(contentEnd - 1) === 13) contentEnd -= 1;
    const rec = text.slice(pos, contentEnd);
    if (rec.length > 0 && rec.indexOf('"') < 0 && rec.indexOf('\r') < 0) {
      const fields = rec.split(',');
      pos = nl < 0 ? len : nl + 1;
      if (nl >= 0) line += 1;
      finishRecord(fields);
      continue;
    }

    const fields = [];
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

    finishRecord(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
