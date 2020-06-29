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
    {gzip: 0, zlib: 1, deflate: 2}[format],
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

var preinitqueue = null;
onmessage = e => {
  if (preinitqueue) {
    preinitqueue.push(e.data);
  } else {
    processmsg(e.data);
  }
};

function processmsg([tag, func, ...args]) {
  try {
    if (func === 'compress') {
      postMessage([tag, 0, compress(...args)]);
    } else if (func === 'makeZip') {
      postMessage([tag, 0, makeZip(...args)]);
    } else {
      throw 'unknown func';
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

