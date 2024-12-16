import type { Timings } from "@szmarczak/http-timer";
import type { Method, BeforeRequestHook, AfterResponseHook, BeforeRetryHook } from "got";

// Define a strict retry options type
type NetsuiteRetryOptions = {
  limit: number;              // Required: Maximum number of retries
  methods?: Method[];         // Optional: HTTP methods to retry
  statusCodes: number[];      // Required: Status codes to retry on
  maxRetryAfter: number;      // Required: Maximum retry delay
  retryAfter: number;        // Required: Default retry delay
  [key: string]: never | number | Method[] | number[] | undefined;
};

// Define a strict hooks type that only allows specified properties
type NetsuiteHooks = {
  beforeRequest?: BeforeRequestHook[];
  afterResponse?: AfterResponseHook[];
  beforeRetry?: BeforeRetryHook[];
  [key: string]: never | BeforeRequestHook[] | AfterResponseHook[] | BeforeRetryHook[] | undefined;
};

export type NetsuiteOptions = {
  consumer_key: string;
  consumer_secret_key: string;
  token: string;
  token_secret: string;
  realm: string;
  base_url?: string;
  hooks?: NetsuiteHooks;
  retry: NetsuiteRetryOptions;  // Required and using strict type
  queue?: {
    concurrency?: number;
    intervalCap?: number;
    interval?: number;
  };
};

export type NetsuiteRequestOptions = {
  path?: string;
  method?: string;
  body?: any;
  heads?: any;
};

export type NetsuiteResponse = {
  statusCode: number;
  headers: NodeJS.Dict<string | string[]>;
  data: any;
  timings?: Timings;
};

export type NetsuiteQueryResult = {
  items: any[];
  hasMore: boolean;
};
