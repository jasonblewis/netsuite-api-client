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

    const queueOptions = {
      concurrency: 5,            // Maximum concurrent requests
      intervalCap: 5,            // Allow full concurrency per interval
      interval: 1000,            // Check every second
      autoStart: true,
      timeout: 0,                // No timeout (use 0 instead of false)
      throwOnTimeout: false      // Don't throw on timeout
    };

    this.requestQueue = new PQueue(queueOptions);

    // Track active requests
    const activeRequests = new Set();

    this.requestQueue.on('active', () => {
      const task = this.requestQueue.pending;
      activeRequests.add(task);
      const now = new Date().toISOString();
      console.log(`[Queue ${now}] Task started (Active: ${this.requestQueue.pending}/${queueOptions.concurrency}, Queued: ${this.requestQueue.size})`);
    });

    this.requestQueue.on('completed', (result, task) => {
      activeRequests.delete(task);
      const now = new Date().toISOString();
      console.log(`[Queue ${now}] Task completed (Active: ${this.requestQueue.pending}/${queueOptions.concurrency}, Queued: ${this.requestQueue.size})`);
    });

    this.requestQueue.on('error', (error, task) => {
      activeRequests.delete(task);
      const now = new Date().toISOString();
      console.log(`[Queue ${now}] Task failed (Active: ${this.requestQueue.pending}/${queueOptions.concurrency}, Queued: ${this.requestQueue.size})`);
    });

    // Store interval ID so we can clear it
    const monitorInterval = setInterval(() => {
      if (this.requestQueue.size > 0 || this.requestQueue.pending > 0) {
        const now = new Date().toISOString();
        console.log(`[Queue ${now}] Status: Active=${this.requestQueue.pending}/${queueOptions.concurrency}, Queued=${this.requestQueue.size}`);
      } else {
        clearInterval(monitorInterval);  // Clear interval when queue is empty
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

  public async request(opts: NetsuiteRequestOptions) {
    const { path = "*", method = "GET", body = "", heads = {} } = opts;

    let uri;
    if (this.base_url) {
      uri = `${this.base_url}/services/rest/${path}`;
    } else {
      uri = `https://${this.realm.toLowerCase().replace("_", "-")}.suitetalk.api.netsuite.com/services/rest/${path}`;
    }

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
        request: 5000,
        response: 5000
      }
    };

    // Merge hooks from constructor
    if (this.hooks) {
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

    try {
      const response = await got(uri, options);

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
      console.log('Error:', error);
      console.log('Error is instance of:', {
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
  }

  public async requestWithRetry(opts: NetsuiteRequestOptions): Promise<NetsuiteResponse> {
    const { path = "*", method = "GET", body = "", heads = {} } = opts;

    let uri;
    if (this.base_url) {
      uri = `${this.base_url}/services/rest/${path}`;
    } else {
      uri = `https://${this.realm.toLowerCase().replace("_", "-")}.suitetalk.api.netsuite.com/services/rest/${path}`;
    }

    const options: OptionsOfTextResponseBody = {
      method: method as Method,
      headers: { Authorization: this.getAuthorizationHeader(uri, method) },
      throwHttpErrors: false,
      decompress: true,
      retry: {
        limit: this.retry?.limit ?? 3,
        methods: this.retry?.methods ?? ['GET' as Method],
        statusCodes: this.retry?.statusCodes ?? [429, 500],
        maxRetryAfter: this.retry?.maxRetryAfter ?? 60,
        calculateDelay: ({ error, attemptCount }) => {
          if (error?.response?.statusCode === 401 || error?.response?.statusCode === 403) {
            return 0;
          }
          // Base delay with exponential backoff starting at 1 second
          const baseDelay = Math.min(1000 * Math.pow(1.8, attemptCount), 15000);
          
          // Add larger random jitter between 1-10 seconds
          const jitter = Math.floor(Math.random() * 9000) + 1000;
          
          return baseDelay + jitter;
        }
      },
      hooks: {
        beforeRetry: [
          ((error, retryCount) => {
            const newAuthHeader = this.getAuthorizationHeader(uri, method);
            if (error.options) {
              error.options.headers = {
                ...error.options.headers,
                Authorization: newAuthHeader
              };
            }
            console.log(`[${new Date().toISOString()}] Retry attempt ${retryCount} with refreshed auth header for ${uri}`);
          }) as BeforeRetryHook
        ]
      },
      timeout: { 
        request: 5000,
        response: 5000
      }
    };

    // Merge hooks from constructor
    if (this.hooks) {
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

    try {
      const response = await got(uri, options);

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
      console.log('Error:', error);
      console.log('Error is instance of:', {
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
  }

  public async requestWithRetryAndRefresh(opts: NetsuiteRequestOptions): Promise<NetsuiteResponse> {
    const result = await this.requestQueue.add<NetsuiteResponse>(async (): Promise<NetsuiteResponse> => {
      const { path = "*", method = "GET", body = "", heads = {} } = opts;

      let uri;
      if (this.base_url) {
        uri = `${this.base_url}/services/rest/${path}`;
      } else {
        uri = `https://${this.realm.toLowerCase().replace("_", "-")}.suitetalk.api.netsuite.com/services/rest/${path}`;
      }

      const options: OptionsOfTextResponseBody = {
        method: method as Method,
        headers: { Authorization: this.getAuthorizationHeader(uri, method) },
        throwHttpErrors: false,
        decompress: true,
        retry: {
          limit: this.retry?.limit ?? 3,
          methods: this.retry?.methods ?? ['GET' as Method],
          statusCodes: this.retry?.statusCodes ?? [429, 500],
          maxRetryAfter: this.retry?.maxRetryAfter ?? 60,
          calculateDelay: ({ error, attemptCount }) => {
            if (error?.response?.statusCode === 401 || error?.response?.statusCode === 403) {
              return 0;
            }
            // Base delay with exponential backoff starting at 1 second
            const baseDelay = Math.min(1000 * Math.pow(1.8, attemptCount), 15000);
            
            // Add larger random jitter between 1-10 seconds
            const jitter = Math.floor(Math.random() * 9000) + 1000;
            
            return baseDelay + jitter;
          }
        },
        hooks: {
          beforeRetry: [
            ((error, retryCount) => {
              const newAuthHeader = this.getAuthorizationHeader(uri, method);
              if (error.options) {
                error.options.headers = {
                  ...error.options.headers,
                  Authorization: newAuthHeader
                };
              }
              console.log(`[${new Date().toISOString()}] Retry attempt ${retryCount} with refreshed auth header for ${uri}`);
            }) as BeforeRetryHook
          ]
        },
        timeout: { 
          request: 5000,
          response: 5000
        }
      };

      // Merge hooks from constructor
      if (this.hooks) {
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

      try {
        const response = await got(uri, options);

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
        console.log('Error:', error);
        console.log('Error is instance of:', {
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
}
