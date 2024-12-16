import OAuth from "oauth-1.0a";
import crypto from "crypto";
import got, { 
  HTTPError, 
  OptionsOfTextResponseBody, 
  Method, 
  Response as GotResponse,
  RequestError,
  BeforeRetryHook,
  Options as OptionsInit
} from "got";
import { Readable } from "stream";
import {
  NetsuiteOptions,
  NetsuiteQueryResult,
  NetsuiteRequestOptions,
  NetsuiteResponse,
} from "./types.js";
import { NetsuiteError } from "./errors.js";
import debug from 'debug';
import PQueue from 'p-queue';
import type { default as PQueueType } from 'p-queue';  // Import the type
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { readFileSync } from 'fs';
import { join } from 'path';

const currentFilePath = fileURLToPath(import.meta.url);
const currentDirPath = dirname(currentFilePath);

const pkgPath = join(currentDirPath, '..', 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const VERSION = pkg.version;

type NetsuiteErrorResponse = {
  name: string;
  message: string;
  responseStatus?: number;
  responseBody?: any;
  isGotError: boolean;
  timestamp: string;
  retryAfter?: string;
  gotOptions?: any;
  gotRetry: {
    retryAfter?: string;
    limit?: number;
    methods?: string[];
    statusCodes?: number[];
    errorCodes?: string[];
    maxRetryAfter?: number;
  };
};

// Create debug loggers for different concerns
const logQueue = debug('netsuite-api:queue');
const logRetry = debug('netsuite-api:retry');
const logRequest = debug('netsuite-api:request');
const logError = debug('netsuite-api:error');
const logDebug = debug('netsuite-api:debug');

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
  private retry?: NetsuiteOptions['retry'];
  private requestQueue: PQueueType;

  constructor(options: NetsuiteOptions) {
    logDebug('NetsuiteApiClient loaded from:', currentFilePath);
    logDebug('Module path:', currentDirPath);

    this.consumer_key = options.consumer_key;
    this.consumer_secret_key = options.consumer_secret_key;
    this.token = options.token;
    this.token_secret = options.token_secret;
    this.version = "1.0";
    this.algorithm = "HMAC-SHA256";
    this.realm = options.realm;
    this.base_url = options.base_url;
    this.hooks = options.hooks;
    this.retry = options.retry;

    // Initialize queue with defaults or custom options
    const queueOptions = {
      concurrency: options.queue?.concurrency ?? 5,  // Default to 5 concurrent requests
      intervalCap: options.queue?.intervalCap ?? 5,  // Default to 5 requests per interval
      interval: options.queue?.interval ?? 1000,     // Default to 1 second interval
      autoStart: true
    };

    this.requestQueue = new PQueue(queueOptions);

    // Track active requests
    const activeRequests = new Set();

    this.requestQueue.on('active', () => {
      const task = this.requestQueue.pending;
      activeRequests.add(task);
      const now = new Date().toISOString();
      logQueue(`Task started (Active: ${this.requestQueue.pending}/${queueOptions.concurrency}, Queued: ${this.requestQueue.size})`);
    });

    this.requestQueue.on('completed', (result, task) => {
      activeRequests.delete(task);
      const now = new Date().toISOString();
      logQueue(`Task completed (Active: ${this.requestQueue.pending}/${queueOptions.concurrency}, Queued: ${this.requestQueue.size})`);
    });

    this.requestQueue.on('error', (error, task) => {
      activeRequests.delete(task);
      const now = new Date().toISOString();
      logQueue(`Task failed (Active: ${this.requestQueue.pending}/${queueOptions.concurrency}, Queued: ${this.requestQueue.size})`);
    });

    // Monitor queue status
    const monitorInterval = setInterval(() => {
      if (this.requestQueue.size > 0 || this.requestQueue.pending > 0) {
        logQueue(`Status: Active=${this.requestQueue.pending}/${queueOptions.concurrency}, Queued=${this.requestQueue.size}`);
      } else {
        clearInterval(monitorInterval);
      }
    }, 5000);
  }

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
   * Makes a request to the Netsuite API with configurable retry behavior
   * @param opts Request options including path, method, and data
   * @returns Promise resolving to the API response
   */
  public async request(opts: NetsuiteRequestOptions): Promise<NetsuiteResponse> {
    const result = await this.requestQueue.add<NetsuiteResponse>(async (): Promise<NetsuiteResponse> => {
      const { path = "*", method = "GET", body = "", heads = {} } = opts;

      logRequest(`Making ${method} request to ${path}`);

      let uri;
      if (this.base_url) {
        uri = `${this.base_url}/services/rest/${path}`;
      } else {
        uri = `https://${this.realm.toLowerCase().replace("_", "-")}.suitetalk.api.netsuite.com/services/rest/${path}`;
      }

      // First set up retry hooks
      // Define retry hooks that will be used to refresh auth header
      const retryHooks = {
        beforeRetry: [
          ((error, retryCount) => {
            logRetry(`Attempt ${retryCount} starting...`);
            const newAuthHeader = this.getAuthorizationHeader(uri, method);
            if (error.options) {
              error.options.headers = {
                'Content-Type': 'application/json',
                Authorization: newAuthHeader,
                ...Object.entries(error.options.headers || {})
                  .filter(([key]) => key.toLowerCase() !== 'authorization')
                  .reduce((acc, [k, v]) => ({ ...acc, [k]: v }), {})
              };
              logRetry(`Auth header refreshed for attempt ${retryCount}: ${newAuthHeader.substring(0, 20)}...`);
            } else {
              logRetry(`Warning: Could not refresh auth header for attempt ${retryCount} - no options object`);
            }
          }) as BeforeRetryHook
        ]
      };

      // Initialize hooks with debug logging
      const initialHooks = {
        ...retryHooks,
        ...(this.hooks || {}),
        beforeRequest: [...(this.hooks?.beforeRequest || [])],
        afterResponse: [...(this.hooks?.afterResponse || [])]
      };
      
      const options: OptionsOfTextResponseBody = {
        method: method as Method,
        headers: { Authorization: this.getAuthorizationHeader(uri, method) },
        throwHttpErrors: false,
        decompress: true,
        retry: {
          limit: this.retry?.limit ?? 3,
          methods: this.retry?.methods ?? ['GET' as Method],
          statusCodes: this.retry?.statusCodes ?? [429, 500, 502, 503, 504],
          maxRetryAfter: this.retry?.retryAfter ?? 5,
          errorCodes: ['ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT'],
          calculateDelay: ({ error, attemptCount }) => {
            // Log retry attempt details
            logRetry(`
              === Retry Calculation ===
              Attempt: ${attemptCount + 1}
              Method: ${method}
              Path: ${path}
              Status: ${error?.response?.statusCode}
              Headers: ${JSON.stringify(error?.response?.headers, null, 2)}
            `);

            // Don't retry on client errors except 429
            if (error?.response?.statusCode && 
                error.response.statusCode >= 400 && 
                error.response.statusCode < 500 && 
                error.response.statusCode !== 429) {
              logRetry(`Not retrying - client error ${error.response.statusCode}`);
              return 0;
            }
            
            // For 429, use user's retry-after if provided
            if (error?.response?.statusCode === 429) {
              const serverRetryAfter = error.response.headers?.['retry-after'];
              const userRetryAfter = this.retry?.retryAfter;
              const delay = (userRetryAfter ?? 5) * 1000;
              
              logRetry(`429 Rate limit exceeded:
                Server retry-after: ${serverRetryAfter}s
                User configured retry-after: ${userRetryAfter}s
                Using delay: ${delay}ms
              `);
              return delay;
            }

            // Exponential backoff with jitter for other retryable errors
            const baseDelay = Math.min(1000 * Math.pow(2, attemptCount), 10000);
            const finalDelay = baseDelay + Math.random() * 1000;
            logRetry(`Using exponential backoff for status ${error?.response?.statusCode}:
              Attempt: ${attemptCount + 1}
              Base delay: ${baseDelay}ms
              Final delay with jitter: ${finalDelay}ms
            `);
            return finalDelay;
          }
        },
        hooks: {
          ...initialHooks,
          beforeRetry: [
            ((error, retryCount) => {
              logRetry(`Attempt ${retryCount} starting...`);
              const newAuthHeader = this.getAuthorizationHeader(uri, method);
              if (error.options) {
                error.options.headers = {
                  'Content-Type': 'application/json',
                  Authorization: newAuthHeader,
                  ...Object.entries(error.options.headers || {})
                    .filter(([key]) => key.toLowerCase() !== 'authorization')
                    .reduce((acc, [k, v]) => ({ ...acc, [k]: v }), {})
                };
                logRetry(`Auth header refreshed for attempt ${retryCount}: ${newAuthHeader.substring(0, 20)}...`);
              } else {
                logRetry(`Warning: Could not refresh auth header for attempt ${retryCount} - no options object`);
              }
            }) as BeforeRetryHook
          ]
        }
      };

      if (Object.keys(heads).length > 0) {
        options.headers = { ...options.headers, ...heads };
      }
      if (body) {
        options.body = body;
        options.headers!.prefer = "transient";
      }

      try {
        const response = await got(uri, options);
        logRequest(`Response received: ${response.statusCode}`);

        if (response.statusCode >= 200 && response.statusCode < 300) {
          return {
            statusCode: response.statusCode,
            headers: response.headers,
            data: response.body ? JSON.parse(response.body.toString()) : null,
            timings: response.timings,
          } as NetsuiteResponse;
        }

        // Parse error response
        let errorMessage = '';
        let errorBody;
        
        try {
          errorBody = JSON.parse(response.body);
          if (errorBody['o:errorDetails']?.[0]?.detail) {
            errorMessage = errorBody['o:errorDetails'][0].detail;
            if (response.headers?.['retry-after']) {
              errorMessage += ` (Retry after: ${response.headers['retry-after']} seconds)`;
            }
          }
        } catch (e) {
          errorMessage = response.body?.toString() || 'Unknown error';
        }

        const errorDetails = {
          name: 'NetsuiteError',
          message: errorMessage,
          responseStatus: response.statusCode,
          responseBody: response.body,
          isGotError: false,
          timestamp: new Date().toISOString(),
          retryAfter: response.headers?.['retry-after'],
          gotOptions: options.retry,
          gotRetry: {
            retryAfter: response.headers?.['retry-after'],
            limit: options.retry?.limit,
            methods: options.retry?.methods,
            statusCodes: options.retry?.statusCodes,
            errorCodes: options.retry?.errorCodes,
            maxRetryAfter: options.retry?.maxRetryAfter
          }
        };
        throw errorDetails;

      } catch (error: unknown) {
        logError('Request failed:', error);
        logError('Error is instance of:', {
          Error: error instanceof Error,
          HTTPError: error instanceof HTTPError,
          RequestError: error instanceof RequestError,
          Object: error instanceof Object,
          NetsuiteErrorResponse: error && typeof error === 'object' && 'name' in error && error.name === 'NetsuiteError'
        });
        
        // If it's already a NetsuiteErrorResponse, just throw it
        if (error && typeof error === 'object' && 'name' in error && error.name === 'NetsuiteError') {
          throw error;
        }

        if (error instanceof HTTPError) {
          const errorDetails: NetsuiteErrorResponse = {
            name: 'NetsuiteError',
            message: error.response.body ? 
              (() => {
                try {
                  const parsed = JSON.parse(error.response.body);
                  return `HTTP ${error.response.statusCode} - ${parsed['o:errorDetails']?.[0]?.detail || parsed.message || error.message}`;
                } catch (e) {
                  return `HTTP ${error.response.statusCode} - ${error.response.body}`;
                }
              })() : `HTTP ${error.response.statusCode} - ${error.message}`,
            responseStatus: error.response.statusCode,
            responseBody: error.response.body,
            isGotError: true,
            timestamp: new Date().toISOString(),
            retryAfter: error.response.headers?.['retry-after'],
            gotOptions: options.retry,
            gotRetry: {
              retryAfter: error.response.headers?.['retry-after'],
              limit: options.retry?.limit,
              methods: options.retry?.methods,
              statusCodes: options.retry?.statusCodes,
              errorCodes: options.retry?.errorCodes,
              maxRetryAfter: options.retry?.maxRetryAfter
            }
          };
          throw errorDetails;
        }

        // For any other type of error (like network errors)
        const errorDetails = {
          name: error instanceof Error ? error.name : 'NetsuiteError',
          message: error instanceof Error ? 
            `Network Error: ${error.message}` : 
            'Network error occurred',
          responseStatus: undefined,
          responseBody: undefined,
          isGotError: false,
          timestamp: new Date().toISOString(),
          retryAfter: undefined,
          gotOptions: options.retry,
          gotRetry: {
            retryAfter: undefined,
            limit: options.retry?.limit,
            methods: options.retry?.methods,
            statusCodes: options.retry?.statusCodes,
            errorCodes: options.retry?.errorCodes,
            maxRetryAfter: options.retry?.maxRetryAfter
          }
        };
        throw errorDetails;
      }
    });
    
    if (!result) {
      logError('Queue operation was cancelled');
      throw new Error('Queue operation was cancelled');
    }
    
    return result;
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

  /**
   * Get information about the client instance
   * @returns {Object} Client information including version and path
   */
  public getClientInfo() {
    return {
      path: currentFilePath,
      modulePath: currentDirPath,
      version: VERSION,
      isTestVersion: VERSION.includes('test')
    };
  }

  /**
   * Verify this is the test version of the client
   * @throws {Error} If not using test version
   */
  public verifyTestVersion() {
    const info = this.getClientInfo();
    if (!info.isTestVersion) {
      throw new Error(`
        Wrong client version! 
        Expected: test version
        Got: ${info.version}
        Path: ${info.path}
      `);
    }
    return true;
  }
}
