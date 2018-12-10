let dns = require('dns');
let url = require('url');

let fetch = require('cross-fetch');
let ip = require('ip');
let luaparse = require('luaparse');
let yaml = require('yaml');

function MetadataError(message) {
  let e = new Error(message);
  e.type = 'CLIENT_ERROR';
  e.code = 'METADATA_ERROR';
  return e;
}

async function dnsResolveAsync(hostname, rrtype) {
  return await new Promise((resolve, reject) => {
    let cb = (err, result) => {
      if (err) {
        reject(err);
      } else {
        resolve(result);
      }
    };
    if (rrtype) {
      dns.resolve(hostname, rrtype, cb);
    } else {
      dns.resolve(hostname, cb);
    }
  });
}

async function getRawMetadataFromSourceFileAsync(sourceCode) {
  // Rules for parsing source files:
  // Ignore shebang lines
  // Look through all the comments that are before any code in the file
  // If any of them start with a line that is `#castle` or `#castle/{format}`
  // then the rest of that comment is the metadata
  // Otherwise, take the first comment and assume that is the metadata
  // If there aren't any comments before, then assume there is no metadata in the source

  let [hasMetadataInComments, metadataText, formatType] = await new Promise((resolve, reject) => {
    let stop = false;
    let commentText = '';
    let resolved = false;

    // FYI - `luaparse` will ignore shebang lines
    try {
      let ast = luaparse.parse(sourceCode, {
        onCreateNode: (node) => {
          if (stop) {
            return;
          }
          switch (node.type) {
            case 'Comment':
              let value = node.value;
              let firstLine = value.split(/[\n\r]/, 1)[0];
              let r = /^#castle(\/([a-z0-9A-Z_\-]+))?$/;
              let m = r.exec(firstLine.trim());
              if (m) {
                let [_castle, _, formatType] = m;
                if (value) {
                  commentText = value.substr(firstLine.length);
                  stop = true;
                  resolve([true, commentText, formatType]);
                  resolved = true;
                }
              } else {
                if (!commentText) {
                  commentText = value;
                }
              }
              break;
            default:
              stop = true;
          }
        },
      });
    } catch (e) {
      console.warn('Problem parsing Lua source code: ' + e);
    }
    if (!resolved) {
      if (commentText) {
        resolve([true, commentText, null]);
      } else {
        resolve([false, null, null]);
      }
      resolved = true;
    }
  });

  return {
    hasMetadataInComments,
    metadataText,
    formatType,
  };
}

async function parseSourceFileAsync(sourceCode) {
  let { hasMetadataInComments, metadataText, formatType } = await getRawMetadataFromSourceFileAsync(
    sourceCode
  );
  if (hasMetadataInComments) {
    return await parseCastleDataAsync(metadataText, formatType);
  }
}

async function parseCastleDataAsync(text, format) {
  switch (format) {
    case 'json':
      return await parseJsonCastleDataAsync(text);
    case 'yaml':
      try {
        return await parseYamlCastleDataAsync(text);
      } catch (e) {
        console.error('Failed to parse YAML: ' + e);
      }
      break;
    default:
      try {
        return await parseJsonCastleDataAsync(text);
      } catch (e) {
        try {
          let result = await parseYamlCastleDataAsync(text);
          if (typeof result === 'object') {
            return result;
          } else {
            return null;
          }
        } catch (e) {
          return null;
        }
      }
  }
}

async function parseYamlCastleDataAsync(text) {
  return yaml.parse(text);
}

async function parseJsonCastleDataAsync(text) {
  return JSON.parse(text);
}

/**
 * Checks to see if a URL is on the public Internet
 *
 * We use this so that we don't request URLs from inside our
 * VPN, or localhost, etc. That could be wasteful at best and
 * potentially a security issue at worst.
 *
 * @param {String} url
 */
async function isPublicUrlAsync(url_) {
  let pu = url.parse(url_);
  if (pu.hostname) {
    let hostAddr = await dnsResolveAsync(pu.hostname);
    return ip.isPublic(hostAddr);
  } else {
    return false;
  }
}

function _keyNameForHeader(header) {
  let n = '';
  let capNext = false;
  for (let c of header.substr('x-castle-'.length)) {
    switch (c) {
      case '-':
        capNext = true;
        break;
      case '.':
        break;
      case '/':
        v = '';
        capNext = false;
        break;
      default:
        if (capNext) {
          n += c.toUpperCase();
        } else {
          n += c;
        }
        capNext = false;
        break;
    }
  }
  return n;
}

async function fetchMetadataForUrlAsync(url_, opts) {
  let urlIsAlsoSourceCode = false;
  opts = opts || {};

  let urlIsPublicUrl = await isPublicUrlAsync(url_);

  if (opts.allowPrivateUrls || urlIsPublicUrl) {
    let response = await fetch(url_);
    let body = await response.text();
    let metadata;
    let contentType = response.headers.get('content-type');
    let shortContentType = contentType.split(';', 1)[0];
    switch (shortContentType) {
      case 'app/castle':
        metadata = await parseCastleDataAsync(body);
        break;
      case 'app/castle+json':
        metadata = await parseCastleDataAsync(body, 'json');
        break;
      case 'app/castle+yaml':
        metadata = await parseCastleDataAsync(body, 'yaml');
        break;

      case 'app/castle+lua':
      case 'text/lua':
      case 'text/love2d':
      case 'app/castle+main':
      case 'app/castle+source':
        urlIsAlsoSourceCode = true;
        metadata = await parseSourceFileAsync(body);
        break;

      default:
        if (url_.endsWith('.castle')) {
          metadata = await parseCastleDataAsync(body);
        } else if (url_.endsWith('.castle.json')) {
          metadata = await parseCastleDataAsync(body, 'json');
        } else if (url_.endsWith('.castle.yaml')) {
          metadata = await parseCastleDataAsync(body, 'yaml');
        } else {
          urlIsAlsoSourceCode = true;
          metadata = await parseSourceFileAsync(body);
        }
        break;
    }

    metadata = metadata || {};

    // Add in metadata from headers
    // TODO(cheever): Should header metadata or metadata in the
    // file take precedence?
    for (let key of response.headers.keys()) {
      if (key.startsWith('x-castle-')) {
        metadata[_keyNameForHeader(key)] = response.headers.get(key);
      }
    }

    // Remove anything that starts with $__ since that could
    // potentially be a security problem, or at least a source
    // of confusion, and there's no reason you should want to do this
    for (let key of Object.keys(metadata)) {
      if (key.startsWith('$__')) {
        console.warn('Got a `$__`-prefixed key in metadata from file (' + key + '); discaring it.');
        delete metadata[key];
      }
    }

    // Add in the information about the requested URL
    metadata.$__requestedFromUrl = url_;
    metadata.$__requestedUrlIsAlsoMainEntryPoint = urlIsAlsoSourceCode;

    if (urlIsAlsoSourceCode) {
      metadata.$__mainUrl = metadata.$__requestedFromUrl;
      if (opts.includeSourceCode) {
        metadata.$__sourceCode = body;
      }
    } else {
      if (metadata.main) {
        metadata.$__mainUrl = url.resolve(metadata.$__requestedFromUrl, metadata.main);
      } else {
        metadata.$__mainUrl = url.resolve(metadata.$__requestedFromUrl, 'main.lua');
      }
    }

    let mainUrlIsPublic = await isPublicUrlAsync(metadata.$__mainUrl);
    if (urlIsPublicUrl && !mainUrlIsPublic) {
      // Maybe there is some reason to allow this, but I think
      // it could cause problems and confusion
      throw MetadataError('Cannot have a private URL be the main URL for a public URL');
    }

    metadata.$__urlIsPublic = urlIsPublicUrl;
    metadata.$__mainUrlIsPublic = mainUrlIsPublic;

    if (metadata.canonicalUrl) {
      metadata.$__canonicalUrl = metadata.canonicalUrl;
      if (!(await isPublicUrlAsync(metadata.$__canonicalUrl))) {
        throw MetadataError('Canonical URL must be a public URL');
      }
    } else {
      if (urlIsPublicUrl) {
        metadata.$__canonicalUrl = url_;
      }
    }

    return metadata;
  } else {
    throw MetadataError("Not a public URL; won't get metadata for it");
  }
}

module.exports = {
  parseCastleDataAsync,
  parseJsonCastleDataAsync,
  parseYamlCastleDataAsync,
  parseSourceFileAsync,
  getRawMetadataFromSourceFileAsync,
  dnsResolveAsync,
  isPublicUrlAsync,
  _keyNameForHeader,
  fetchMetadataForUrlAsync,
};
