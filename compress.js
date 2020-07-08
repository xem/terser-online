"use strict";

function ensureByteBuffer(input) {
  if (typeof input === 'string') {
    return Uint8Array.from(
      encodeURIComponent(input)
        .replace(/%(..)/g, (_, m) => String.fromCharCode(parseInt(m, 16))),
      c => c.charCodeAt());
  } else {
    return input;
  }
}

// adapted from https://stackoverflow.com/a/18639999/225272
var crcTable = function(){
  var c;
  var crcTable = [];
  for(var n =0; n < 256; n++){
    c = n;
    for(var k =0; k < 8; k++){
      c = ((c&1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1));
    }
    crcTable[n] = c;
  }
  return crcTable;
}();

function crc32(str) {
  var crc = 0 ^ (-1);
  for (var i = 0; i < str.length; i++ ) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ str[i]) & 0xFF];
  }
  return (crc ^ (-1)) >>> 0;
}

function makeZip(filename, inflated, deflated) {
  console.assert(typeof filename === 'string', 'filename should be a string');
  filename = filename.trim();
  console.assert(filename.match(/^[0-9a-zA-Z-._]+$/),
    'okay, listen. I do in fact think that filename restriction in various filesystems ' +
    'is generally lame, but isn\'t this supposed to be a code-golfing tool? ' +
    'what\'s a benefit with non-conventional filenames? break autojudges? *shrug*'
  ); // we also don't want to deal with filename character encodings
  console.assert(inflated instanceof Uint8Array, 'inflated should be a Uint8Array');
  console.assert(deflated instanceof Uint8Array, 'deflated should be a Uint8Array');

  const two = v => [v, v >>> 8];
  const four = v => [v, v >>> 8, v >>> 16, v >>> 24];

  const inflatedcrc = four(crc32(inflated));
  const date = new Date;
  const datetime = four(
    (date.getSeconds() >> 1) |
    (date.getMinutes() << 5) |
    (date.getHours() << 11) |
    (date.getDate() << 16) |
    ((date.getMonth() + 1) << 21) |
    ((date.getFullYear() - 1980) << 25));
  const inflatedsz = four(inflated.length);
  const deflatedsz = four(deflated.length);
  const filenamebuf = ensureByteBuffer(filename);
  const filenamesz = two(filenamebuf.length);
  const centraldirsz = four(46 + filenamebuf.length);
  const centraldiroff = four(76 + filenamebuf.length * 2 + deflated.length);

  return Uint8Array.from([
    // local file header (30 bytes plus filename)
    0x50, 0x4b, 0x03, 0x04, // signature
    0x14, 0x00, // min version needed to extract (2.0, as we use deflate)
    0x00, 0x00, // general purpose bitflag
    0x08, 0x00, // compression method (8, deflate)
    ...datetime, // modified time & date
    ...inflatedcrc, // crc32 of uncompressed data
    ...deflatedsz, // compressed size
    ...inflatedsz, // uncompressed size
    ...filenamesz, // file name length
    0x00, 0x00, // extra field length (we have none)
    ...filenamebuf,

    // compressed file data
    ...deflated,

    // central directory file header (46 bytes plus filename)
    0x50, 0x4b, 0x01, 0x01, // signature
    0x1e, 0x00, // "version made by" (format 2.0, file made in MS-DOS :-)
    0x14, 0x00, // min version needed to extract
    0x00, 0x00, // general purpose bitflag
    0x08, 0x00, // compression method
    ...datetime, // modified time & date
    ...inflatedcrc, // crc32 of uncompressed data
    ...deflatedsz, // compressed size
    ...inflatedsz, // uncompressed size
    ...filenamesz, // file name length
    0x00, 0x00, // extra field length
    0x00, 0x00, // file comment length (we have none)
    0x00, 0x00, // starting disk number (0)
    0x00, 0x00, // internal file attributes (bit 0 unset: binary)
    0x00, 0x00, 0x00, 0x00, // external file attributes (made from stdin)
    0x00, 0x00, 0x00, 0x00, // file offset relative to first disk (0)
    ...filenamebuf,

    // end of central directory record (22 bytes)
    0x50, 0x4b, 0x05, 0x06, // signature
    0x00, 0x00, // current disk number (0)
    0x00, 0x00, // starting disk number of central directory
    0x01, 0x00, // number of central directory records in current disk (1)
    0x01, 0x00, // number of central directory records (1)
    ...centraldirsz, // size of central directory
    ...centraldiroff, // offset to central directory
    0x00, 0x00, // comment length (0)
  ]);
}

function makePng(width, height, deflated, bootstrap) {
  const four = v => [v >>> 24, v >>> 16, v >>> 8, v];
  const chunk = (len, data) => [...four(len), ...data, ...four(crc32(data))];

  bootstrap = ensureByteBuffer(bootstrap);
  if (bootstrap.length < 1 || bootstrap[0] !== 0x3c) {
    throw 'invalid bootstrap code (should start with `<`)';
  }

  const image = [
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // signature

    // IHDR
    ...chunk(13, [
      0x49, 0x48, 0x44, 0x52,
      ...four(width), // image width
      ...four(1), // image height = 1
      0x08, // bit depth = 8
      0x00, // color type = grayscale
      0x00, // compression method = zlib
      0x00, // filter method = 0
      0x00, // interlace = no
    ]),

    // IDAT
    // recent browsers tolerate missing CRC in the IDAT chunk
    // *only when they are at the end of the file*.
    // thus we should pretend that the boostrap code is actually
    // a part of compressed bitstream left unused instead.
    ...chunk(
      deflated.length + bootstrap.length + 3, // overshooting is okay
      [0x49, 0x44, 0x41, 0x54, ...deflated],
    ).slice(0, -4),

    // IEND (omitted)
    //...chunk([0x49, 0x45, 0x4e, 0x44]),
  ];

  const overlap = overlapOrClose(image, bootstrap);
  if (typeof overlap === 'number') {
    return Uint8Array.from([...image, ...bootstrap.slice(overlap)]);
  } else {
    return Uint8Array.from([...image, ...overlap, ...bootstrap]);
  }
}

// returns a number of bytes that can be overlap,
// or a suffix (of the maximum length 3) required to reset the parsing state
function overlapOrClose(prefix, bootstrap) {
  // this is a partial but compliant HTML5 parser, assuming that browsers do not
  // detect this "HTML" as ISO-2022-JP (probably impossible due to the PNG signature).
  //
  // the goal is to determine a part of the prefix that can be shared with bootstrap
  // and the parser returns to the known-good initial state at the beginning of the suffix.
  // we don't do the tree reconstruction stage, so we bail out when generated tokens
  // would alter the tokenization stage (this should be relatively rare).

  // transitions[currentState][charClass] => nextState
  //
  // charClass is a single character, or "alpha" [A-Za-z] or "space" [\x09\x0a\x0c\x20].
  // if the nextState for given char class doesn't exist, fall back to the "default" class.
  // some transitions are intentionally commented out, they don't affect the outcome.
  //
  // the nextState may have prefixes (processed in this order):
  // - `$` stashes the current character to the dedicated tag name & markup decl. storage.
  //   each time also checks for the forbidden tags (case insensitively) and bails out if found.
  //   (so if `xmp` is forbidden we also forbid `XmP` or `xmpa`. okay with false positives.)
  // - `>` clears the storage ("emit the current tag token" in the spec).
  // - `@` retries a given charClass in the nextState ("reconsume" in the spec).
  const transitions = {
    data: { default: 'data', /*'&': 'charRef',*/ '<': 'tagOpen' },
    tagOpen: { default: '@data', '!': '$markupDeclOpen', '/': 'endTagOpen', alpha: '$tagName', '?': 'bogusComment' },
    endTagOpen: { default: '@bogusComment', alpha: '$tagName', '>': 'data' },
    tagName: { default: '$tagName', space: 'beforeAttrName', '/': 'selfClosingStartTag', '>': '>data' },
    beforeAttrName: { default: '@attrName', space: 'beforeAttrName', '/': '@afterAttrName', '>': '@afterAttrName', '=': 'attrName' },
    attrName: { default: 'attrName', space: '@afterAttrName', '/': '@afterAttrName', '>': '@afterAttrName', '=': 'beforeAttrValue' },
    afterAttrName: { default: '@attrName', space: 'afterAttrName', '/': 'selfClosingStartTag', '=': 'beforeAttrValue', '>': '>data' },
    beforeAttrValue: { default: '@attrValueUnquoted', space: 'beforeAttrValue', '"': 'attrValueDoubleQuoted', "'": 'attrValueSingleQuoted', '>': '>data' },
    attrValueDoubleQuoted: { default: 'attrValueDoubleQuoted', '"': 'afterAttrValueQuoted', /*'&': 'charRef'*/ },
    attrValueSingleQuoted: { default: 'attrValueSingleQuoted', "'": 'afterAttrValueQuoted', /*'&': 'charRef'*/ },
    attrValueUnquoted: { default: 'attrValueUnquoted', space: 'beforeAttrName', /*'&': 'charRef',*/ '>': '>data' },
    afterAttrValueQuoted: { default: '@beforeAttrName', space: 'beforeAttrName', '/': 'selfClosingStartTag', '>': '>data' },
    selfClosingStartTag: { default: '@beforeAttrName', '>': '>data' },
    bogusComment: { default: 'bogusComment', '>': 'data' },

    // markupDeclOpen requires lookahead, we expand it into three artifical states
    markupDeclOpen: { default: '$markupDecl', '-': '>markupDeclDash', '>': '>data' },
    markupDecl: { default: '$markupDecl', '>': '>data' },
    markupDeclDash: { default: 'bogusComment', '-': 'commentStart', '>': 'data' },

    commentStart: { default: '@comment', '-': 'commentStartDash', '>': 'data' },
    commentStartDash: { default: '@comment', '-': 'commentEnd', '>': 'data' },
    comment: { default: 'comment', /*'<': 'commentLessThanSign',*/ '-': 'commentEndDash' },
    commentEndDash: { default: '@comment', '-': 'commentEnd' },
    commentEnd: { default: '@comment', '>': 'data', '!': 'commentEndBang', '-': 'commentEnd' },
    commentEndBang: { default: '@comment', '-': 'commentEndDash', '>': 'data' },
  };

  const forbiddenTags = [
    // contents expects the non-data state
    'title', 'textarea', // expects RCDATA
    'style', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript', // expects raw text
    'script', // expects script data
    'plaintext', // expects PLAINTEXT

    // the insertion mode for contents disables the script processing
    'frameset', // "in frameset" insertion mode (ignores all unknown tags)

    // otherwise problematic
    'template', // contained scripts have a null browsing context, so don't run immediately
    '!doctype', // affects quirks mode or similar
    '![cdata[', // only activated in some tags, actually case sensitive but we don't care
  ];

  const transitOnce = (state, stashed, c) => {
    const cls =
      0x61 <= (c | 0x20) && (c | 0x20) <= 0x7a ? 'alpha' :
      c === 0x09 || c === 0x0a || c === 0x0c || c == 0x20 ? 'space' :
      String.fromCharCode(c);
    state = transitions[state][cls] || transitions[state].default;
    if (state[0] === '$') {
      stashed += String.fromCharCode(0x41 <= c && c <= 0x5a ? c + 0x20 : c);
      if (forbiddenTags.indexOf(stashed) >= 0) {
        throw 'the compressed data contains a problematic `<' + stashed + '` tag, try other input';
      }
      state = state.slice(1);
    } else if (state[0] === '>') {
      stashed = '';
      state = state.slice(1);
    }
    return { state, stashed }; // we handle @-transitions from the caller
  };

  const transit = (state, stashed, c) => {
    let passingThruData = state === 'data';
    ({ state, stashed } = transitOnce(state, stashed, c));
    while (state[0] === '@') {
      passingThruData |= state === '@data';
      ({ state, stashed } = transitOnce(state.slice(1), stashed, c));
    }
    return { state, stashed, passingThruData };
  };

  let state = 'data', stashed = '';
  for (let i = 0; i < prefix.length; ++i) {
    // can we overlap with the bootstrap here?
    let canOverlap = true;
    for (let j = 0; j < bootstrap.length && i + j < prefix.length; ++j) {
      if (prefix[i + j] !== bootstrap[j]) {
        canOverlap = false;
        break;
      }
    }

    // are we passing thru the "data" state while processing this character?
    let passingThruData;
    ({ state, stashed, passingThruData } = transit(state, stashed, prefix[i]));
    if (canOverlap && passingThruData) return prefix.length - i;
  }

  // the minimal suffix required to reach the "data" state
  const suffix = {
    data: '',
    tagOpen: '',
    endTagOpen: '>',
    tagName: '>',
    beforeAttrName: '>',
    attrName: '>',
    afterAttrName: '>',
    beforeAttrValue: '>',
    attrValueDoubleQuoted: '">',
    attrValueSingleQuoted: "'>",
    attrValueUnquoted: '>',
    afterAttrValueQuoted: '>',
    selfClosingStartTag: '>',
    bogusComment: '>',
    markupDeclOpen: '>',
    markupDecl: '>',
    markupDeclDash: '>',
    commentStart: '>',
    commentStartDash: '>',
    comment: '-->',
    commentEndDash: '->',
    commentEnd: '>',
    commentEndBang: '>',
  }[state];

  // verification
  for (const c of suffix) {
    ({ state, stashed } = transit(state, stashed, c.charCodeAt()));
  }
  if (!transit(state, stashed, bootstrap[0]).passingThruData) {
    throw 'bug: suffix did not reset the parsing state';
  }
  return suffix;
}

// assumes the zopfli output; error handling is sparse
// format is same as zopfli: 0 (gzip), 1 (zlib), 2 (deflate)
// output is [[DEFLATE overhead, [bit size, inflated buf], ...], ...]
// e.g. [[25, [9, [65]], [7, [66, 67, 68]]]] corresponds to a stream
//      where `A` encoded in 9 bits, `BCD` together encoded in 7 bits,
//      and all wrapped with 25 bit overhead from DEFLATE (not counting containers)
function* mapZopfli(format, deflated) {
  let cur = 0;
  let end = deflated.length;

  if (format === 0) {
    if (deflated[0] !== 0x1f) throw 'gzip with incorrect magic1';
    if (deflated[1] !== 0x8b) throw 'gzip with incorrect magic2';
    if (deflated[2] !== 0x08) throw 'gzip with unexpected compression method';
    const flags = deflated[3];
    cur = 10;
    if (flags & 0x04) cur += 2 + (deflated[cur] | deflated[cur + 1] << 8) + 2; // FEXTRA
    if (flags & 0x08) cur = deflated.indexOf(0, cur) + 1; // FNAME
    if (flags & 0x10) cur = deflated.indexOf(0, cur) + 1; // FCOMMENT
    if (flags & 0x02) cur += 2; // FHCRC
    end -= 8;
  } else if (format === 1) {
    if ((deflated[0] & 0x0f) !== 0x08) throw 'zlib with unexpected compression method';
    if (deflated[1] & 0x20) throw 'zlib with unexpected preset dictionary';
    if (((deflated[0] << 8 | deflated[1]) >>> 0) % 31) throw 'zlib with incorrect check'; 
    cur = 2;
    end -= 4;
  }

  let unread = 0;
  let nunread = 0; // bits
  const nbitsRead = () => cur * 8 + nunread;
  const bits = (nbits=1) => {
    while (nunread < nbits) {
      if (cur >= end) throw 'incomplete deflate stream';
      unread |= deflated[cur++] << nunread;
      nunread += 8;
    }
    const read = unread & ((1 << nbits) - 1);
    unread >>= nbits;
    nunread -= nbits;
    return read;
  };
  const bytes = (nbytes=1) => {
    if (cur + nbytes >= end) throw 'incomplete deflate stream';
    unread = nunread = 0; // sync to byte boundary
    const start = cur;
    cur += nbytes;
    return deflated.slice(start, cur);
  };

  const lzWindow = [];
  while (true) {
    const blockStart = nbitsRead();
    const blockIsFinal = bits();
    const blockType = bits(2);
    if (blockType == 0) {
      const [len1, len2] = bytes(4);
      const len = len1 | len2 << 8;
      const overhead = nbitsRead() - blockStart;
      const read = bytes(len);
      lzWindow.push(...read);
      yield [overhead, [len * 8, read]];
    } else if (blockType === 3) {
      throw 'deflate with reserved block type';
    } else {
      const treeFromLengths = lengths => {
        const tree = {};
        let code = 0;
        for (let i = 1; i < lengths.length; ++i) {
          lengths.forEach((length, symbol) => {
            if (length === i) tree[[i, code++]] = symbol;
          });
          code <<= 1;
        }
        tree.maxLength = lengths.length - 1;
        return tree;
      };

      const decodeFromTree = tree => {
        let read = 0;
        let nread = 0;
        do {
          read = read << 1 | bits();
          ++nread;
          const symbol = tree[[nread, read]];
          if (symbol !== undefined) return [nread, symbol];
        } while (nread <= tree.maxLength);
        throw 'invalid huffman code in deflate stream';
      };

      let litOrLenTree, distTree;
      if (blockType === 1) {
        let i = 0, j;
        litOrLenTree = { maxLength: 9 };
        for (j = 0b00110000; i < 144; ) litOrLenTree[[8, j++]] = i++;
        for (j = 0b110010000; i < 256; ) litOrLenTree[[9, j++]] = i++;
        for (j = 0b0000000; i < 280; ) litOrLenTree[[7, j++]] = i++;
        for (j = 0b11000000; i < 288; ) litOrLenTree[[8, j++]] = i++;
        distTree = { maxLength: 5 };
        for (i = j = 0; i < 32; ) distTree[[5, j++]] = i++;
      } else {
        const ncodes = bits(5) + 257; // # of (non-literal) length codes
        const ndists = bits(5) + 1; // # of distance codes

        // intermediate tree
        const nicodes = bits(4) + 4;
        const icodes = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15].slice(0, nicodes);
        const icodeLengths = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        for (const icode of icodes) icodeLengths[icode] = bits(3);
        const icodeTree = treeFromLengths(icodeLengths);

        // actual huffman trees (two of them, but decoded into a single stream before split)
        const codeLengths = [];
        while (codeLengths.length < ncodes + ndists) {
          const [_, c] = decodeFromTree(icodeTree);
          if (c === 16) {
            const last = codeLengths[codeLengths.length - 1];
            for (let i = bits(2) + 3; i > 0; --i) codeLengths.push(last);
          } else if (c === 17) {
            for (let i = bits(3) + 3; i > 0; --i) codeLengths.push(0);
          } else if (c === 18) {
            for (let i = bits(7) + 11; i > 0; --i) codeLengths.push(0);
          } else {
            codeLengths.push(c);
          }
        }
        litOrLenTree = treeFromLengths(codeLengths.slice(0, ncodes));
        distTree = treeFromLengths(codeLengths.slice(ncodes));
      }

      const lenBase = [
        3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31,
        35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258,
      ];
      const lenBits = [
        0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3,
        4, 4, 4, 4, 5, 5, 5, 5, 0,
      ];
      const distBase = [
        1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129,
        193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097,
        6145, 8193, 12289, 16385, 24577,
      ];
      const distBits = [
        0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7,
        8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
      ];

      const block = [nbitsRead() - blockStart];
      while (true) {
        let [nread, c] = decodeFromTree(litOrLenTree);
        if (c < 256) {
          block.push([nread, [c]]);
          lzWindow.push(c);
        } else if (c === 256) {
          block[0] += nread; // end-of-block symbol is kinda overhead
          break;
        } else {
          c -= 257;
          nread += lenBits[c];
          const length = bits(lenBits[c]) + lenBase[c];
          [, c] = decodeFromTree(distTree);
          nread += distBits[c];
          const distance = bits(distBits[c]) + distBase[c];
          for (let i = 0; i < length; ++i) {
            lzWindow.push(lzWindow[lzWindow.length - distance]);
          }
          block.push([nread, lzWindow.slice(-length)]);
        }
      }
      yield block;
    }
    if (blockIsFinal) break;
  }
}

