import OAuth from "oauth-1.0a";
import crypto from "crypto";
import got, { 
  HTTPError, 
  OptionsOfTextResponseBody, 
  Method, 
  Response as GotResponse
} from "got";
import { Readable } from "stream";
import {
  NetsuiteOptions,
  NetsuiteQueryResult,
  NetsuiteRequestOptions,
  NetsuiteResponse,
} from "./types.js";
import { NetsuiteError } from "./errors.js";
import type { PlainResponse } from 'got';
import debug from 'debug';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const logDir = path.join(__dirname, '../../logs');
const logFile = path.join(logDir, 'netsuite-debug.log');

// Log immediately when module is loaded
fs.mkdirSync(logDir, { recursive: true });
fs.writeFileSync(logFile, `${new Date().toISOString()} - Module loaded from: ${__filename}\n`);

const logToFile = (message: string) => {
  try {
    fs.writeFileSync(logFile, `${new Date().toISOString()} - ${message}\n`, { flag: 'a' });
  } catch (error) {
    console.error('Failed to write to log file:', error);
  }
};

export default class NetsuiteApiClient {
  private consumer_key: string;
  private consumer_secret_key: string;
  private token: string;
  private token_secret: string;
  private version: string;
  private algorithm: string;
  private realm: string;
  private base_url?: string;
  private hooks?: NetsuiteOptions['hooks'];

  constructor(options: NetsuiteOptions) {
    this.consumer_key = options.consumer_key;
    this.consumer_secret_key = options.consumer_secret_key;
    this.token = options.token;
    this.token_secret = options.token_secret;
    this.version = "1.0";
    this.algorithm = "HMAC-SHA256";
    this.realm = options.realm;
    this.base_url = options.base_url;
    this.hooks = options.hooks;
  }

  /**
   * Retrieve the Authorization Header
   * @param options
   * @returns
   */
  getAuthorizationHeader(url: string, method: string) {
    const oauth = new OAuth({
      consumer: {
        key: this.consumer_key,
        secret: this.consumer_secret_key,
      },
      realm: this.realm,
      signature_method: this.algorithm,
      hash_function(base_string, key) {
        return crypto.createHmac("sha256", key).update(base_string).digest("base64");
      },
    });
    return oauth.toHeader(
      oauth.authorize(
        {
          url,
          method,
        },
        {
          key: this.token,
          secret: this.token_secret,
        }
      )
    ).Authorization as string;
  }

  /**
   * Run a raw REST API request
   * @param opts
   * @returns
   */
  public async request(opts: NetsuiteRequestOptions) {
    logToFile('NetsuiteApiClient.request called');
    const { path = "*", method = "GET", body = "", heads = {} } = opts;

    let uri;
    if (this.base_url) {
      uri = `${this.base_url}/services/rest/${path}`;
    } else {
      uri = `https://${this.realm.toLowerCase().replace("_", "-")}.suitetalk.api.netsuite.com/services/rest/${path}`;
    }

    logToFile(`Creating request options for URI: ${uri}`);

    const options: OptionsOfTextResponseBody = {
      method: method as Method,
      headers: { Authorization: this.getAuthorizationHeader(uri, method) },
      throwHttpErrors: false,
      decompress: true,
      retry: { 
        limit: 0,
        methods: [],
        statusCodes: [],
        errorCodes: [],
        maxRetryAfter: 0
      },
      timeout: { 
        request: 1000,
        response: 1000 
      }
    };

    // Merge hooks from constructor
    if (this.hooks) {
      logToFile('Applying hooks from constructor');
      options.hooks = {
        beforeRequest: [
          ...(this.hooks.beforeRequest || []),
          ...(options.hooks?.beforeRequest || [])
        ],
        afterResponse: [
          ...(this.hooks.afterResponse || []),
          ...(options.hooks?.afterResponse || [])
        ]
      };
    }

    if (Object.keys(heads).length > 0) {
      options.headers = { ...options.headers, ...heads };
    }
    if (body) {
      options.body = body;
      options.headers!.prefer = "transient";
    }

    logToFile(`Making request with options: ${JSON.stringify({
      method: options.method,
      retry: options.retry,
      timeout: options.timeout,
      hasHooks: !!options.hooks
    }, null, 2)}`);

    try {
      const response = await got(uri, options);
      logToFile(`Got response: ${response.statusCode}`);

      if (response.statusCode >= 200 && response.statusCode < 300) {
        return {
          statusCode: response.statusCode,
          headers: response.headers,
          data: response.body ? JSON.parse(response.body.toString()) : null,
          timings: response.timings,
        } as NetsuiteResponse;
      }

      throw new NetsuiteError(new HTTPError(response as any));

    } catch (error: unknown) {
      logToFile(`Request error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      if (error instanceof HTTPError) {
        throw new NetsuiteError(error);
      }
      throw error instanceof Error ? error : new Error('Unknown error');
    }
  }

  /**
   * Connect !
   * @returns
   */
  public async connect() {
    return await this.request({
      path: "*",
      method: "OPTIONS",
    });
  }

  /**
   * Run SuiteQL query
   * @param query
   * @param limit
   * @param offset
   * @returns
   */
  public async query(query: string, limit = 1000, offset = 0) {
    let queryResult: NetsuiteQueryResult = { items: [], hasMore: false };
    if (limit > 1000) throw new Error("Max limit is 1000");
    // replace all \t with spaces as suggested in #5
    query = query.replace(/\t/g, " ");
    query = query.replace(/\r?\n|\r/gm, "");
    let bodyContent = `{"q": "${query}" }`;
    const response = await this.request({
      path: `query/v1/suiteql?limit=${limit}&offset=${offset}`,
      method: "POST",
      body: bodyContent,
    });
    queryResult.items = response.data.items;
    queryResult.hasMore = response.data.hasMore;
    return queryResult;
  }

  /**
   * Run and then combine all pages of a query
   * @param query
   * @param limit
   * @returns
   */
  public queryAll(query: string, limit = 1000) {
    const stream = new Readable({
      objectMode: true,
      read() {},
    });
    let offset = 0;
    const getNextPage = async () => {
      try {
        let hasMore = true;
        while (hasMore === true) {
          let sqlResult = await this.query(query, limit, offset);
          sqlResult.items.forEach((item) => stream.push(item));
          hasMore = sqlResult.hasMore;
          offset = offset + limit;
        }
        stream.push(null);
      } catch (error) {
        stream.emit('error', error);
      }
    };
    getNextPage();
    return stream;
  }
}
