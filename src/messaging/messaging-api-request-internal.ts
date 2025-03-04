/*!
 * @license
 * Copyright 2017 Google Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { App } from '../app';
import { FirebaseApp } from '../app/firebase-app';
import {
  HttpMethod, AuthorizedHttpClient, HttpRequestConfig, RequestResponseError, RequestResponse,
  AuthorizedHttp2Client, Http2SessionHandler, Http2RequestConfig,
} from '../utils/api-request';
import { createFirebaseError, getErrorCode } from './messaging-errors-internal';
import { SubRequest, BatchRequestClient } from './batch-request-internal';
import { getSdkVersion } from '../utils/index';
import { SendResponse, BatchResponse } from './messaging-api';


// FCM backend constants
const FIREBASE_MESSAGING_TIMEOUT = 15000;
const FIREBASE_MESSAGING_BATCH_URL = 'https://fcm.googleapis.com/batch';
const FIREBASE_MESSAGING_HTTP_METHOD: HttpMethod = 'POST';
const FIREBASE_MESSAGING_HEADERS = {
  'X-Firebase-Client': `fire-admin-node/${getSdkVersion()}`,
  'X-Goog-Api-Client': `gl-node/${process.versions.node} fire-admin/${getSdkVersion()}`
};
const LEGACY_FIREBASE_MESSAGING_HEADERS = {
  'X-Firebase-Client': `fire-admin-node/${getSdkVersion()}`,
  'X-Goog-Api-Client': `gl-node/${process.versions.node} fire-admin/${getSdkVersion()}`,
  'access_token_auth': 'true',
};


/**
 * Class that provides a mechanism to send requests to the Firebase Cloud Messaging backend.
 */
export class FirebaseMessagingRequestHandler {
  private readonly httpClient: AuthorizedHttpClient;
  private readonly http2Client: AuthorizedHttp2Client;
  private readonly batchClient: BatchRequestClient;

  /**
   * @param app - The app used to fetch access tokens to sign API requests.
   * @constructor
   */
  constructor(app: App) {
    this.httpClient = new AuthorizedHttpClient(app as FirebaseApp);
    this.http2Client = new AuthorizedHttp2Client(app as FirebaseApp);
    this.batchClient = new BatchRequestClient(
      this.httpClient, FIREBASE_MESSAGING_BATCH_URL, FIREBASE_MESSAGING_HEADERS);
  }

  /**
   * Invokes the request handler with the provided request data.
   *
   * @param host - The host to which to send the request.
   * @param path - The path to which to send the request.
   * @param requestData - The request data.
   * @returns A promise that resolves with the response.
   */
  public invokeRequestHandler(host: string, path: string, requestData: object): Promise<object> {
    const request: HttpRequestConfig = {
      method: FIREBASE_MESSAGING_HTTP_METHOD,
      url: `https://${host}${path}`,
      data: requestData,
      headers: LEGACY_FIREBASE_MESSAGING_HEADERS,
      timeout: FIREBASE_MESSAGING_TIMEOUT,
    };
    return this.httpClient.send(request).then((response) => {
      // Send non-JSON responses to the catch() below where they will be treated as errors.
      if (!response.isJson()) {
        throw new RequestResponseError(response);
      }

      // Check for backend errors in the response.
      const errorCode = getErrorCode(response.data);
      if (errorCode) {
        throw new RequestResponseError(response);
      }

      // Return entire response.
      return response.data;
    })
      .catch((err) => {
        if (err instanceof RequestResponseError) {
          throw createFirebaseError(err);
        }
        // Re-throw the error if it already has the proper format.
        throw err;
      });
  }

  /**
   * Invokes the HTTP/1.1 request handler with the provided request data.
   *
   * @param host - The host to which to send the request.
   * @param path - The path to which to send the request.
   * @param requestData - The request data.
   * @returns A promise that resolves with the {@link SendResponse}.
   */
  public invokeHttpRequestHandlerForSendResponse(
    host: string, path: string, requestData: object
  ): Promise<SendResponse> {
    const request: HttpRequestConfig = {
      method: FIREBASE_MESSAGING_HTTP_METHOD,
      url: `https://${host}${path}`,
      data: requestData,
      headers: LEGACY_FIREBASE_MESSAGING_HEADERS,
      timeout: FIREBASE_MESSAGING_TIMEOUT,
    };
    return this.httpClient.send(request).then((response) => {
      return this.buildSendResponse(response);
    })
      .catch((err) => {
        if (err instanceof RequestResponseError) {
          return this.buildSendResponseFromError(err);
        }
        // Re-throw the error if it already has the proper format.
        throw err;
      });
  }

  /**
   * Invokes the HTTP/2 request handler with the provided request data.
   *
   * @param host - The host to which to send the request.
   * @param path - The path to which to send the request.
   * @param requestData - The request data.
   * @returns A promise that resolves with the {@link SendResponse}.
   */
  public invokeHttp2RequestHandlerForSendResponse(
    host: string, path: string, requestData: object, http2SessionHandler: Http2SessionHandler
  ): Promise<SendResponse> {
    const request: Http2RequestConfig = {
      method: FIREBASE_MESSAGING_HTTP_METHOD,
      url: `https://${host}${path}`,
      data: requestData,
      headers: LEGACY_FIREBASE_MESSAGING_HEADERS,
      timeout: FIREBASE_MESSAGING_TIMEOUT,
      http2SessionHandler: http2SessionHandler
    };
    return this.http2Client.send(request).then((response) => {
      return this.buildSendResponse(response);
    })
      .catch((err) => {
        if (err instanceof RequestResponseError) {
          return this.buildSendResponseFromError(err);
        }
        // Re-throw the error if it already has the proper format.
        throw err;
      });
  }

  /**
   * Sends the given array of sub requests as a single batch to FCM, and parses the result into
   * a `BatchResponse` object.
   *
   * @param requests - An array of sub requests to send.
   * @returns A promise that resolves when the send operation is complete.
   */
  public sendBatchRequest(requests: SubRequest[]): Promise<BatchResponse> {
    return this.batchClient.send(requests)
      .then((responses: RequestResponse[]) => {
        return responses.map((part: RequestResponse) => {
          return this.buildSendResponse(part);
        });
      }).then((responses: SendResponse[]) => {
        const successCount: number = responses.filter((resp) => resp.success).length;
        return {
          responses,
          successCount,
          failureCount: responses.length - successCount,
        };
      }).catch((err) => {
        if (err instanceof RequestResponseError) {
          throw createFirebaseError(err);
        }
        // Re-throw the error if it already has the proper format.
        throw err;
      });
  }

  private buildSendResponse(response: RequestResponse): SendResponse {
    const result: SendResponse = {
      success: response.status === 200,
    };
    if (result.success) {
      result.messageId = response.data.name;
    } else {
      result.error = createFirebaseError(new RequestResponseError(response));
    }
    return result;
  }

  private buildSendResponseFromError(err: RequestResponseError): SendResponse {
    return {
      success: false,
      error: createFirebaseError(err)
    };
  }
}
