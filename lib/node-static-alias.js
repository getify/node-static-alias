/*
 * node-static-alias
 * https://github.com/anseki/node-static-alias
 *
 * Copyright (c) 2018 anseki
 * Licensed under the MIT license.
 */

// EDITED: Kyle Simpson

'use strict';

var staticSuper = require('node-static'),
  fs = require('fs'),
  events = require('events'),
  path = require('path'),
  url = require('url'),
  querystring = require('querystring'),
  platform = process.platform;

function Server() {
  var that = this;
  staticSuper.Server.apply(that, arguments); // Super class constructor

  if (that.options.alias) { // To Array
    if (!Array.isArray(that.options.alias)) {
      that.options.alias = [that.options.alias];
    }
    that.options.alias.forEach(function(alias) {
      alias.match = !alias.match ? [] :
        !Array.isArray(alias.match) ? [alias.match] :
        alias.match;
      alias.serve = !alias.serve ? ['<% absPath %>'] :
        !Array.isArray(alias.serve) ? [alias.serve] :
        alias.serve;
    });
  }

  if (that.options.logger) {
    ['info', 'log'].some(function(methodName) {
      if (typeof that.options.logger[methodName] === 'function') {
        that._log = function() {
          that.options.logger[methodName].apply(that.options.logger, arguments);
        };
        return true;
      }
      return false;
    });
  }
  that._log = that._log || function() {};
}

function isPromise(val) {
  return (
    val &&
    typeof val == "object" &&
    (val instanceof Promise || "then" in val)
  );
}

// util.inherits()
Server.prototype = Object.create(staticSuper.Server.prototype);
Server.prototype.constructor = Server;

Server.prototype.servePath = function(pathname, status, headers, req, res, finish) {
  var that = this,
    servePath = that.parsePath(pathname, req, res),
    promise = new events.EventEmitter();

  if (servePath) {
    if (isPromise(servePath)) { // Wait for promise to handle serving.
      servePath.then(handleServing).catch(function(){
        finish(500, {});
      });
    } else { // Handle serving immediately.
      handleServing(servePath);
    }
  } else {
    // Forbidden
    finish(403, {});
  }
  return promise;

  function handleServing(resolvedPath) {
    fs.stat(resolvedPath, function(e, stat) {
      if (e) {
        finish(404, {});
      } else if (stat.isFile()) { // Stream a single file.
        that.respond(null, status, headers, [resolvedPath], stat, req, res, finish);
      } else if (stat.isDirectory()) { // Stream a directory of files.
        that.serveDir(resolvedPath, req, res, finish);
      } else {
        finish(400, {});
      }
    });
  }
};

Server.prototype.parsePath = function(pathname, req, res) {
  var that = this,
    params = {absPath: that.resolve(pathname)},
    allowOutside = false,
    key, query, servePath;

  if (!that.options.alias) { return params.absPath; }

  if (req.headers) {
    // The strange HTTP header like a 'reqPath' may come from client. But, ignore it.
    for (key in req.headers) {
      if (key !== 'absPath') { params[key] = req.headers[key] + ''; }
    }
  }

  params.reqPath = pathname;
  params.reqDir = path.dirname(params.reqPath);
  params.absDir = path.dirname(params.absPath);
  params.fileName = path.basename(params.reqPath);
  // params.suffix = path.extname(params.reqPath).replace(/^\./, '');
  params.basename = params.fileName.replace(/^([^.].*)\.([^.]*)$/,
    function(s, basename, suffix) {
      params.suffix = suffix;
      return basename;
    });
  params.suffix = params.suffix != null ? params.suffix : '';

  if ((params.reqUrl = req.url) && (params.reqQuery = url.parse(params.reqUrl).query)) {
    query = querystring.parse(params.reqQuery);
    Object.keys(query).forEach(function(key) {
      if (typeof query[key] === 'string') {
        params['query_' + key] = query[key];
      } else { // it should be Array
        query[key].forEach(function(value, i) {
          params['query_' + key + '[' + i + ']'] = value + '';
        });
      }
    });
  }

  that._log('(%s) Requested: "%s"', params.reqPath, params.absPath);

  function inRoot(servePath) {
    return (platform === 'win32'
      ? servePath.toLowerCase().indexOf(that.root.toLowerCase()) : // Windows
      servePath.indexOf(that.root) // Others
    ) === 0 ? servePath : false;
  }

  function parseTemplate(template) {
    return template.replace(/<%\s*(.+?)\s*%>/g, function(s, key) {
      return params[key] != null ? params[key] : '';
    });
  }

  var aliasesResult = checkAliases([...that.options.alias], 0);

  if (isPromise(aliasesResult)) { // Wait on promise.
    return aliasesResult.then(resolvePath);
  } else {
    return resolvePath(aliasesResult);
  }

  function checkAliases([alias, ...aliases], iAlias) {
    var matchesResult = checkMatches([...alias.match], 0);

    if (isPromise(matchesResult)) { // Wait for promise.
      return matchesResult.then(handleMatchesResult);
    } else {
      return handleMatchesResult(matchesResult);
    }

    function checkMatches([match, ...matches], i) {
      var key, value;
      if (typeof match === 'string') {
        value = match.replace(/^(?:(.*?)=)?(.*)$/, function(s, pKey, pValue) {
          key = pKey;
          return pValue;
        });
        if (params[key || 'reqPath'] === value) {
          return [true,i];
        }
        return checkMatches(matches, i + 1);
      }
      if (typeof match === 'object' && match instanceof RegExp && match.test(params.reqPath)) {
        return [true,i];
      }
      if (typeof match === 'function') {
        let fnResult = match.call(that, params, req, res);

        if (isPromise(fnResult)) { // Wait on promise.
          return fnResult.then(function(matchResult){
            if (matchResult) {
              return [true,i];
            } else if (matches.length > 0) {
              return checkMatches(matches, i + 1);
            }
            else {
              return [false,undefined];
            }
          });
        } else if (fnResult) {
          return [true,i];
        }
      }
      if (matches.length > 0) {
        return checkMatches(matches, i + 1); // check next match
      } else {
        return [false,undefined];
      }
    }

    function handleMatchesResult([matched,iMatch] = []) {
      if (matched) {
        let servesResult = checkServes([...alias.serve], 0);

        if (isPromise(servesResult)) { // Wait for promise.
          return servesResult.then(handleServesResult);
        } else {
          return handleServesResult(servesResult);
        }
      } else if (aliases.length > 0) {
        return checkAliases(aliases, iAlias + 1);
      } else {
        return false;
      }

      function checkServes([serve, ...serves], iServe) {
        // Not that.resolve() because it's not uri.
        if (typeof serve === 'string') {
          return checkServePath(path.resolve(that.root, parseTemplate(serve)));
        } else if (typeof serve === 'function') {
          let fnResult = serve.call(that, params, req, res);

          if (isPromise(fnResult)) { // Wait on promise.
            return fnResult.then(function(serveResult){
              return checkServePath(path.resolve(that.root, serveResult));
            });
          } else {
            return checkServePath(path.resolve(that.root, fnResult));
          }
        } else {
          return checkServePath(params.absPath);
        }

        function checkServePath(absPath) {
          if (alias.force || fs.existsSync(absPath)) {
            return [absPath,iServe];
          } else if (serves.length > 0) {
            return checkServes(serves, iServe + 1);
          }
          else {
            return [false,undefined];
          }
        }
      }

      function handleServesResult([servesResult,iServe] = []) {
        if (servesResult) {
          servePath = servesResult;
          allowOutside = alias.allowOutside;
          that._log('(%s) For Serve: "%s" alias[%d] match[%d] serve[%d]',
            params.reqPath, servePath, iAlias, iMatch, iServe);
          return servePath;
        }
        return false;
      }
    }
  }

  function resolvePath(resolvedPath) {
    return resolvedPath ?
      (allowOutside ? resolvedPath : inRoot(resolvedPath)) :
      inRoot(params.absPath);
  }
};

exports.Server = Server;
exports.mime = staticSuper.mime;
