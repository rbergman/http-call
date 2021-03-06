import http = require('http')
import * as uri from 'url'
import * as util from 'util'

import { deps } from './deps'

const pjson = require('../package.json')
const debug = require('debug')('http')
const debugHeaders = require('debug')('http:headers')
const debugBody = require('debug')('http:body')

interface IErrorWithCode extends Error {
  code?: string
}

function concat(stream: NodeJS.ReadableStream) {
  return new Promise(resolve => {
    let strings: string[] = []
    stream.on('data', data => strings.push(data))
    stream.on('end', () => resolve(strings.join('')))
  })
}

export type Protocol = 'https:' | 'http:'

/**
 * @typedef {Object} HTTPRequestOptions
 * @property {Object.<string, string>} headers - request headers
 * @property {string} method - request method (GET/POST/etc)
 * @property {(string)} body - request body. Sets content-type to application/json and stringifies when object
 * @property {(boolean)} partial - do not make continuous requests while receiving a Next-Range header for GET requests
 * @property {(number)} port - port to use
 */
export type FullHTTPRequestOptions = http.ClientRequestArgs & {
  raw?: boolean
  body?: any
  partial?: boolean
  headers: http.OutgoingHttpHeaders
}

export type HTTPRequestOptions = Partial<FullHTTPRequestOptions>

interface HTTPRequest {
  method: string
  headers: http.OutgoingHttpHeaders
  raw: boolean
  host: string
  port: number
  protocol: Protocol
  body?: any
  partial: boolean
  path: string
  agent?: any
}

function caseInsensitiveObject(): { [k: string]: any } {
  let lowercaseKey = (k: any) => (typeof k === 'string' ? k.toLowerCase() : k)
  return new Proxy({} as { [k: string]: any }, {
    get: (t, k) => {
      k = lowercaseKey(k)
      return t[k]
    },
    set: (t, k, v) => {
      k = lowercaseKey(k)
      t[k] = v
      return true
    },
    deleteProperty: (t, k) => {
      k = lowercaseKey(k)
      if (k in t) return false
      return delete t[k]
    },
    has: (t, k) => {
      k = lowercaseKey(k)
      return k in t
    },
  })
}

function lowercaseHeaders(headers: http.OutgoingHttpHeaders | object): http.OutgoingHttpHeaders {
  let newHeaders = caseInsensitiveObject()
  for (let k of Object.keys(headers)) {
    if (!(headers as any)[k] && (headers as any)[k] !== '') continue
    newHeaders[k] = (headers as any)[k]
  }
  return newHeaders
}

/**
 * Utility for simple HTTP calls
 * @class
 */
export class HTTP {
  static defaults: HTTPRequestOptions = {
    method: 'GET',
    host: 'localhost',
    protocol: 'https:',
    path: '/',
    raw: false,
    partial: false,
    headers: {},
  }

  static create(options: HTTPRequestOptions = {}): typeof HTTP {
    const defaults = this.defaults
    return class CustomHTTP extends HTTP {
      static defaults = {
        ...defaults,
        ...options,
      }
    }
  }

  /**
   * make an http GET request
   * @param {string} url - url or path to call
   * @param {HTTPRequestOptions} options
   * @returns {Promise}
   * @example
   * ```js
   * const http = require('http-call')
   * await http.get('https://google.com')
   * ```
   */
  static get(url: string, options: HTTPRequestOptions = {}) {
    return this.request(url, { ...options, method: 'GET' })
  }

  /**
   * make an http POST request
   * @param {string} url - url or path to call
   * @param {HTTPRequestOptions} options
   * @returns {Promise}
   * @example
   * ```js
   * const http = require('http-call')
   * await http.post('https://google.com')
   * ```
   */
  static post(url: string, options: HTTPRequestOptions = {}) {
    return this.request(url, { ...options, method: 'POST' })
  }

  /**
   * make an http PUT request
   * @param {string} url - url or path to call
   * @param {HTTPRequestOptions} options
   * @returns {Promise}
   * @example
   * ```js
   * const http = require('http-call')
   * await http.put('https://google.com')
   * ```
   */
  static put(url: string, options: HTTPRequestOptions = {}) {
    return this.request(url, { ...options, method: 'PUT' })
  }

  /**
   * make an http PATCH request
   * @param {string} url - url or path to call
   * @param {HTTPRequestOptions} options
   * @returns {Promise}
   * @example
   * ```js
   * const http = require('http-call')
   * await http.patch('https://google.com')
   * ```
   */
  static async patch(url: string, options: HTTPRequestOptions = {}) {
    return this.request(url, { ...options, method: 'PATCH' })
  }

  /**
   * make an http DELETE request
   * @param {string} url - url or path to call
   * @param {HTTPRequestOptions} options
   * @returns {Promise}
   * @example
   * ```js
   * const http = require('http-call')
   * await http.delete('https://google.com')
   * ```
   */
  static async delete(url: string, options: HTTPRequestOptions = {}) {
    return this.request(url, { ...options, method: 'DELETE' })
  }

  /**
   * make a streaming request
   * @param {string} url - url or path to call
   * @param {HTTPRequestOptions} options
   * @returns {Promise}
   * @example
   * ```js
   * const http = require('http-call')
   * let {response} = await http.get('https://google.com')
   * response.on('data', console.log)
   * ```
   */
  static stream(url: string, options: HTTPRequestOptions = {}) {
    return this.request(url, { ...options, raw: true })
  }

  static async request(url: string, options: HTTPRequestOptions = {}): Promise<HTTP> {
    let http = new this(url, options)
    await http._request()
    return http
  }

  // instance properties

  response: http.IncomingMessage
  request: http.ClientRequest
  body: any
  options: FullHTTPRequestOptions

  private _redirectRetries: number
  private _errorRetries: number

  get method(): string {
    return this.options.method || 'GET'
  }
  get statusCode(): number {
    if (!this.response) return 0
    return this.response.statusCode || 0
  }
  get secure(): boolean {
    return this.options.protocol === 'https:'
  }
  get url(): string {
    return `${this.options.protocol}//${this.options.host}${this.options.path}`
  }
  set url(input: string) {
    let u = uri.parse(input)
    this.options.protocol = u.protocol || this.options.protocol
    this.options.host = u.hostname || this.ctor.defaults.host || 'localhost'
    this.options.path = u.path || '/'
    this.options.agent = this.options.agent || deps.proxy.agent(this.secure)
    this.options.port = u.port || (this.secure ? 443 : 80)
  }
  get headers(): http.IncomingMessage['headers'] {
    if (!this.response) return {}
    return this.response.headers
  }
  get partial(): boolean {
    if (this.method !== 'GET' || this.options.partial) return true
    return !(this.headers['next-range'] && this.body instanceof Array)
  }
  get ctor() {
    return this.constructor as typeof HTTP
  }

  constructor(url: string, options: HTTPRequestOptions = {}) {
    const userAgent =
      (global['http-call'] && global['http-call']!.userAgent && global['http-call']!.userAgent) ||
      `${pjson.name}/${pjson.version} node-${process.version}`
    this.options = {
      ...this.ctor.defaults,
      ...options,
      headers: lowercaseHeaders({
        'user-agent': userAgent,
        ...this.ctor.defaults.headers,
        ...options.headers,
      }),
    }
    if (!url) throw new Error('no url provided')
    this.url = url
    if (this.options.body) this._parseBody(this.options.body)
  }

  async _request() {
    this._debugRequest()
    try {
      this.response = await this._performRequest()
    } catch (err) {
      debug(err)
      return this._maybeRetry(err)
    }
    if (this._shouldParseResponseBody) await this._parse()
    this._debugResponse()
    if (this._responseRedirect) return this._redirect()
    if (!this._responseOK) {
      throw new HTTPError(this)
    }
    if (!this.partial) await this._getNextRange()
  }

  async _redirect() {
    if (!this._redirectRetries) this._redirectRetries = 0
    this._redirectRetries++
    if (this._redirectRetries > 10) throw new Error(`Redirect loop at ${this.url}`)
    if (!this.headers.location) throw new Error(`Redirect from ${this.url} has no location header`)
    const location = this.headers.location
    if (Array.isArray(location)) {
      this.url = location[0]
    } else {
      this.url = location
    }
    await this._request()
  }

  async _maybeRetry(err: Error) {
    if (!this._errorRetries) this._errorRetries = 0
    this._errorRetries++
    const allowed = (err: IErrorWithCode): boolean => {
      if (this._errorRetries > 5) return false
      if (!err.code) return false
      if (err.code === 'ENOTFOUND') return true
      return require('is-retry-allowed')(err)
    }
    if (allowed(err)) {
      let noise = Math.random() * 100
      // tslint:disable-next-line
      await this._wait((1 << this._errorRetries) * 100 + noise)
      await this._request()
      return
    }
    throw err
  }

  _debugRequest() {
    if (this.options.agent) debug('proxy: %o', this.options.agent)
    debug('--> %s %s', this.options.method, this.url)
    debugHeaders(this._redactedHeaders(this.options.headers))
    if (this.options.body) debugBody(this.options.body)
  }

  _debugResponse() {
    debug('<-- %s %s %s', this.method, this.url, this.statusCode)
    debugHeaders(this._redactedHeaders(this.headers))
    if (this.body) debugBody(this.body)
  }

  _performRequest(): Promise<http.IncomingMessage> {
    return new Promise((resolve, reject) => {
      if (this.secure) {
        this.request = deps.https.request(this.options, resolve)
      } else {
        this.request = deps.http.request(this.options, resolve)
      }
      this.request.on('error', reject)
      if (this.options.body && deps.isStream.readable(this.options.body)) {
        this.options.body.pipe(this.request)
      } else {
        this.request.end(this.options.body)
      }
    })
  }

  async _parse() {
    this.body = await concat(this.response)
    let json =
      this.response.headers['content-type'] && deps.contentType.parse(this.response).type.startsWith('application/json')
    if (json) this.body = JSON.parse(this.body)
  }

  _parseBody(body: object) {
    if (deps.isStream.readable(body)) {
      this.options.body = body
      return
    }
    if (!this.options.headers['content-type']) {
      this.options.headers['content-type'] = 'application/json'
    }

    if (this.options.headers['content-type'] === 'application/json') {
      this.options.body = JSON.stringify(body)
    } else {
      this.options.body = body
    }
    this.options.headers['content-length'] = Buffer.byteLength(this.options.body).toString()
  }

  async _getNextRange() {
    const next = this.headers['next-range']
    this.options.headers.range = Array.isArray(next) ? next[0] : next
    let prev = this.body
    await this._request()
    this.body = prev.concat(this.body)
  }

  _redactedHeaders(headers: http.IncomingHttpHeaders | http.OutgoingHttpHeaders) {
    headers = { ...headers }
    if (headers.authorization) headers.authorization = '[REDACTED]'
    return headers
  }

  get _responseOK(): boolean {
    if (!this.response) return false
    return this.statusCode >= 200 && this.statusCode < 300
  }

  get _responseRedirect(): boolean {
    if (!this.response) return false
    return [301, 302, 303, 307, 308].includes(this.statusCode)
  }

  get _shouldParseResponseBody(): boolean {
    return !this._responseOK || (!this.options.raw && this._responseOK)
  }

  _wait(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }
}

export default HTTP

export class HTTPError extends Error {
  statusCode: number
  http: HTTP
  body: any
  __httpcall = pjson.version

  constructor(http: HTTP) {
    super()
    if (typeof http.body === 'string' || typeof http.body.message === 'string')
      this.message = http.body.message || http.body
    else this.message = util.inspect(http.body)
    this.message = `HTTP Error ${http.statusCode} for ${http.method} ${http.url}\n${this.message}`
    this.statusCode = http.statusCode
    this.http = http
    this.body = http.body
  }
}
