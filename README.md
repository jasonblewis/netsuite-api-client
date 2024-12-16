# Netsuite API Client

[![Node.js CI](https://github.com/julbrs/netsuite-api-client/actions/workflows/node.js.yml/badge.svg)](https://github.com/julbrs/netsuite-api-client/actions/workflows/node.js.yml) [![npm version](https://badge.fury.io/js/netsuite-api-client.svg)](https://www.npmjs.com/package/netsuite-api-client) [![downloads](https://img.shields.io/npm/dm/netsuite-api-client.svg)](https://www.npmjs.com/package/netsuite-api-client)

Run REST calls and SuiteQL queries against NetSuite SuiteTalk WebServices.

## Why this new package?

This package is a fork & merge of popular Netsuite packages [netsuite-rest](https://www.npmjs.com/package/netsuite-rest) & [suiteql](https://www.npmjs.com/package/suiteql), see [here](https://github.com/ehmad11/netsuite-rest/issues/27#issuecomment-1751798730) for the motivation. This package is **ESM only**. It adds **types** thanks to TypeScript, and **more recent dependencies** to handle recent CVEs on `got` package mainly. It meant to be **actively supported** in the future.

If you need to stay on **CommonJS**, you can still use [netsuite-rest](https://www.npmjs.com/package/netsuite-rest) or [suiteql](https://www.npmjs.com/package/suiteql) by [ehmad11](https://github.com/ehmad11)!

# Installation

```
npm i netsuite-api-client
```

## Quick Start

To set up TBA in Netsuite, see the help topic [Getting Started with Token-based Authentication](https://system.netsuite.com/app/help/helpcenter.nl?fid=section_4247337262.html).

```ts
import { NetsuiteApiClient } from "netsuite-api-client";
const client = new NetsuiteApiClient({
  consumer_key: process.env.consumer_key,
  consumer_secret_key: process.env.consumer_secret_key,
  token: process.env.token,
  token_secret: process.env.token_secret,
  realm: process.env.realm,
  base_url: process.env.base_url,
});
```

## request

### Test

```ts
client
  .request({
    path: "*",
    method: "OPTIONS",
  })
  .then((response) => console.log(response))
  .catch((err) => console.log(err));
```

### GET

```ts
client
  .request({
    path: "record/v1/customer/",
  })
  .then((response) => response.data)
  .then((data) => console.log(data.links))
  .catch((err) => console.log(err));
```

## query

```ts
query(string, (limit = 1000), (offset = 0));
```

- **string** - Select query to run
- **limit** - Limit number of rows, max is 1000
- **offset** - Rows to start from

This method returns with the promise support, response will be in JSON format

### Example

```ts
const transactions = await client.query("select id from transaction", 10, 0);
```

## queryAll (Stream)

When working on large number of rows, stream is handy

```ts
queryAll(string, (limit = 1000));
```

- **string** - Select query to run
- **limit** - Limit number of rows, max is 1000

### Example

```ts
const items = [];
const st = client.queryAll(`
        select
            tranid, id from transaction
        where
            rownum <= 30
    `);

st.on("data", (data) => {
  items.push(data);
});

st.on("end", () => {
  console.log("stream ended");
});

st.on("error", (err) => {
  console.log(err);
});
```

## Response

Requests are returned with promise support. HTTP response codes other than 2xx will cause the promise to be rejected.

The Netsuite error will be preserved in the error message, so you don't have to read the got `HttpError` ! For example:

```
Invalid search query. Detailed unprocessed description follows. Search error occurred: Unknown identifier 'not_existing_field'. Available identifiers are: {customer=customer}
```

## Metadata

```ts
client.request({ path: "record/v1/metadata-catalog/" });
```

Record is the name of the service we are trying to access, v1 is the service version, and metadata-catalog is the sub-resource, that is, the record metadata. The response informs you through HATEOAS links about the possible mediaType flavor in which the response can be obtained.

## HATEOAS

You can navigate to the referenced resources without deeper knowledge of the system. A typical response contains "links" sections for each resource, which can be a sub-resource of a parent resource or any other referenced resource. You can use links to work with those resources.

## More Resources

### SuiteTalk REST Web Services

[Overview and Setup](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/chapter_1540391670.html) - Official Documentation

### Netsuite Rest API Browser

[REST API Browser](https://system.netsuite.com/help/helpcenter/en_US/APIs/REST_API_Browser/record/v1/2021.2/index.html) provides a visual overview of the structure and capabilities of the REST web services Record API. The data presented in the REST API Browser is based on OpenAPI 3.0 metadata.

## Debugging

This library uses the [debug](https://github.com/debug-js/debug) module for logging. To enable logs, set the DEBUG environment variable:

```bash
# Enable all logs
DEBUG=* node your-script.js

# Enable specific logs
DEBUG=netsuite-api:queue node your-script.js    # Queue operations only
DEBUG=netsuite-api:retry node your-script.js    # Retry operations only
DEBUG=netsuite-api:request node your-script.js  # Request/response logs only
DEBUG=netsuite-api:error node your-script.js    # Error logs only

# Enable multiple specific logs
DEBUG=netsuite-api:queue,netsuite-api:retry node your-script.js

# When using test scripts, you can combine namespaces
DEBUG=test:*,netsuite-api:* node your-script.js     # All test and client logs
DEBUG=test:error,netsuite-api:error node your-script.js  # Error logs only from both
```

By default, no debug logs are output unless explicitly enabled via the DEBUG environment variable.

The logging levels follow standard conventions:
- debug: Most verbose - technical details
- info: General information
- warn: Warnings
- error: Errors
