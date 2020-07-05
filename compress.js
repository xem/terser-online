"use strict";

this.window = this;
importScripts('libzopfli.js');

// assumes that window.Module is a wasm output for zopfli
// adapted from https://github.com/gfx/universal-zopfli-js/
const z = window.Module;

function ensureByteBuffer(input) {
  if (typeof input === 'string') {
    const a = z.intArrayFromString(input);
    a.length--; // because emscripten's intArrayFromString() adds trailing nul
    return a;
  } else {
    return input;
  }
}

const defaultOptions = {
  verbose: false,
  verbose_more: false,
  numiterations: 15,
  blocksplitting: true,
  blocksplittingmax: 15,
};

function compress(input, format, options) {
  console.assert(input != null, "buffer must not be null");
  console.assert(options != null, "options must not be null");

  const byteBuffer = ensureByteBuffer(input);
  const bufferPtr = z.allocate(byteBuffer, 'i8', z.ALLOC_NORMAL);

  const opts = { ...defaultOptions, ...options };

  const output = z._createZopfliJsOutput();
  z._compress(bufferPtr, byteBuffer.length, output,
    format,
    opts.verbose,
    opts.verbose_more,
    opts.numiterations,
    opts.blocksplitting,
    opts.blocksplittingmax,
  );

  const outputPtr = z._getBuffer(output);
  const outputSize = z._getBufferSize(output);

  const result = z.HEAPU8.slice(outputPtr, outputPtr + outputSize);
  z._deallocate(outputPtr);
  z._deallocate(output);
  z._deallocate(bufferPtr);

  return result;
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

function makePng(width, deflated, bootstrap) {
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

var preinitqueue = null;
onmessage = e => {
  if (preinitqueue) {
    preinitqueue.push(e.data);
  } else {
    processmsg(e.data);
  }
};

const funcs = { compress, makeZip, makePng };
function processmsg([tag, funcname, ...args]) {
  try {
    const func = funcs[funcname];
    if (func) {
      postMessage([tag, 0, func(...args)]);
    } else {
      throw 'unknown func ' + funcname;
    }
  } catch (e) {
    postMessage([tag, 1, e.toString()]);
  }
};

// libzopfli may be initialized asynchronously, need to delay message processing
if (!runtimeInitialized) {
  preinitqueue = [];
  addOnInit(() => {
    const queue = preinitqueue;
    preinitqueue = null;
    for (const data of queue) processmsg(data);
  });
}

