import { Injectable, Optional } from '@angular/core';
import { Router, Params, NavigationStart, NavigationEnd } from '@angular/router';
import { XhrFactory } from '@angular/common';
import { HttpBackend, HttpErrorResponse, HttpEvent, HttpRequest, HttpResponse, HttpXhrBackend, HttpHeaders } from '@angular/common/http';

import { Observable, of, throwError } from 'rxjs';
import { delay } from 'rxjs/operators';

import { pickAllPropertiesAsGetters } from './pick-properties';
import {
  ApiMockConfig,
  ApiMockService,
  CacheData,
  ApiMockRootRoute,
  ApiMockRoute,
  PartialRoutes,
  RouteDryMatch,
  ChainParam,
  HttpMethod,
  ObjectAny,
  ResponseOptions,
  ResponseOptionsLog,
  MockData,
  isFormData,
  ApiMockDataCallbackOptions,
  ApiMockResponseCallbackOptions,
} from './types';
import { Status, getStatusText } from './http-status-codes';

@Injectable()
export class HttpBackendService implements HttpBackend {
  protected isInited: boolean = false;
  protected cachedData: CacheData = {};
  protected routes: ApiMockRoute[] = [];
  /**
   * Root route paths with host, but without restId. Has result of transformation:
   * - `part1/part2/:paramName` -> `part1/part2`
   * - or `https://example.com/part1/part2/:paramName` -> `https://example.com/part1/part2`
   *
   * Array of paths revert sorted by length.
   */
  protected rootRoutes: PartialRoutes = [];

  constructor(
    protected apiMockService: ApiMockService,
    protected config: ApiMockConfig,
    protected xhrFactory: XhrFactory,
    @Optional() protected router: Router
  ) {}

  handle(req: HttpRequest<any>): Observable<HttpEvent<any>> {
    try {
      return this.handleReq(req);
    } catch (err: any) {
      this.logErrorResponse(req, 'Error 500: Internal Server Error;', err);
      const internalErr = this.makeError(req, Status.INTERNAL_SERVER_ERROR, err.message);
      return throwError(internalErr);
    }
  }

  /**
   * Handles requests.
   */
  protected handleReq(req: HttpRequest<any>): Observable<HttpEvent<any>> {
    if (!this.isInited) {
      this.init();
    }

    const normalizedUrl = req.url.charAt(0) == '/' ? req.url.slice(1) : req.url;
    const routeIndex = this.findRouteIndex(this.rootRoutes, normalizedUrl);

    if (routeIndex == -1) {
      return this.send404Error(req);
    }

    const groupRouteDryMatch = this.getRouteDryMatch(normalizedUrl, this.routes[routeIndex]);

    if (groupRouteDryMatch.length) {
      for (const routeDryMatch of groupRouteDryMatch) {
        const chainParams = this.getChainParams(routeDryMatch);
        if (chainParams) {
          return this.sendResponse(req, chainParams);
        }
      }
    }
    return this.send404Error(req);
  }

  protected init() {
    // Merge with default configs.
    this.config = new ApiMockConfig(this.config);
    this.routes = this.apiMockService.getRoutes().filter((r) => r);
    this.routes.forEach((route) => this.checkRoute(route));
    this.checkRootDuplicates(this.routes);
    this.rootRoutes = this.getRootPaths(this.routes);

    if (this.config.showLog && this.config.clearPrevLog && this.router) {
      let isLoadedApp = false;
      this.router.events.subscribe((event) => {
        if (isLoadedApp && event instanceof NavigationStart) {
          console.clear();
        } else if (event instanceof NavigationEnd) {
          isLoadedApp = true;
        }
      });
    }

    this.isInited = true;
  }

  protected checkRoute(route: ApiMockRootRoute | ApiMockRoute, parentPath?: string) {
    const isLastRoute = !(route.children && route.children.length);
    const path = route.path;
    const host = (route as ApiMockRootRoute).host;
    /**
     * Path with a primary key, like `one/two/:id`.
     */
    const pathWithPk = /^(?:[\w-]+\/)+:\w+$/;
    const childPath = [parentPath, route.path].filter((s) => s).join(' -> ');

    // Nested routes should to have route.dataCallback and primary keys.
    if (!isLastRoute && (!route.dataCallback || !pathWithPk.test(path))) {
      throw new Error(
        `ApiMockModule detected wrong nested routes with path "${childPath}".
With these routes you should to use a primary key in nested route path,
for example "api/posts/:postId/comments", where ":postId" is a primary key of collection "api/posts".
Also you should to have corresponding route.dataCallback.`
      );
    }

    // route.dataCallback should to have corresponding a primary key, and vice versa.
    if ((route.dataCallback && !pathWithPk.test(path)) || (pathWithPk.test(path) && !route.dataCallback)) {
      throw new Error(
        `ApiMockModule detected wrong route with path "${childPath}".
If you have route.dataCallback, you should to have corresponding a primary key, and vice versa.
Also you can remove route.dataCallback if you no need any data from this route.`
      );
    }

    // route.dataCallback should to have corresponding a primary key.
    if (path && path.slice(-1) == '/') {
      throw new Error(
        `ApiMockModule detected wrong route with path "${childPath}".
route.path should not to have trailing slash.`
      );
    }

    if (route.dataCallback && typeof route.dataCallback != 'function') {
      throw new Error(`Route dataCallback with path "${path}" is not a function`);
    }
    if (route.responseCallback && typeof route.responseCallback != 'function') {
      throw new Error(`Route responseCallback with path "${path}" is not a function`);
    }

    // Checking a path.host
    if (host && (typeof host != 'string' || host.slice(-1) == '/')) {
      throw new Error(
        `ApiMockModule detected wrong host "${host}".
Any host must have a string type, and should not end with trailing slash.`
      );
    }

    if (!isLastRoute && route.children) {
      route.children.forEach((child) => this.checkRoute(child, childPath));
    }
  }

  protected checkRootDuplicates(routes: (ApiMockRootRoute | ApiMockRoute)[]) {
    const existingRoutes: string[] = [];
    const incomingRoutes = routes.map((route) => {
      const rootPath = route.path.split(':')[0];
      return [(route as ApiMockRootRoute).host, rootPath].filter((s) => s).join(' -> ');
    });

    incomingRoutes.forEach((incomingRoute) => {
      if (existingRoutes.includes(incomingRoute)) {
        throw new Error(`ApiMockModule detected duplicate route with path: '${incomingRoute}'`);
      }
      existingRoutes.push(incomingRoute);
    });
  }

  protected getRootPaths(routes: (ApiMockRootRoute | ApiMockRoute)[]): PartialRoutes {
    const rootRoutes = routes.map((route, index) => {
      // Transformation: `https:// example.com/part1/part2/:paramName` -> `https://example.com/part1/part2`
      const part = route.path.split('/:')[0];
      const path = [(route as ApiMockRootRoute).host, part].filter((s) => s).join('/');
      const length = path.length;
      return { path, length, index };
    });

    // Revert sorting by path length.
    return rootRoutes.sort((a, b) => b.length - a.length);
  }

  protected findRouteIndex(rootRoutes: PartialRoutes, url: string): number {
    for (const rootRoute of rootRoutes) {
      // We have `rootRoute.length + 1` to avoid such case:
      // (url) `posts-other/123` == (route) `posts/123`
      const partUrl = url.substr(0, rootRoute.length + 1);
      if (partUrl == rootRoute.path || partUrl == `${rootRoute.path}/`) {
        return rootRoute.index;
      }
    }

    return -1;
  }

  /**
   * This method should accepts an URL that matched to a route path by a root segment, for example:
   * - `root-segment/segment` and `root-segment/:routeId`
   * - `root-segment/segment` and `root-segment/other/:routeId`.
   *
   * Then this method splites them by `/` and compares number parts of `splitedUrl` with number parts of `splitedRoute`
   * and if they are equal, returns that route with some metadata.
   *
   * @param normalizedUrl If we have URL without host, here should be url with removed slash from the start.
   * @param rootRoute Root route from `this.routes` that matched to a URL by root path (`rootRoute.host` + `rootRoute.path`).
   */
  protected getRouteDryMatch(normalizedUrl: string, rootRoute: ApiMockRootRoute): RouteDryMatch[] {
    const splitedUrl = normalizedUrl.split('/');
    /**
     * `['posts', '123', 'comments', '456']` -> 4 parts of a URL.
     */
    const countPartOfUrl = splitedUrl.length;
    const routeDryMatch: RouteDryMatch[] = [];
    const host = (rootRoute as ApiMockRootRoute).host || '';
    setRouteDryMatch(rootRoute, host);
    return routeDryMatch;

    function setRouteDryMatch(
      route: ApiMockRoute,
      pathOfRoute?: string,
      routes?: ApiMockRoute[]
    ): RouteDryMatch | void {
      routes = (routes || []).slice();
      routes.push(route);
      pathOfRoute = [pathOfRoute, route.path].filter((s) => s).join('/');
      const splitedRoute = pathOfRoute.split('/');
      let hasLastRestId: boolean = false;
      let lastPrimaryKey: string = '';
      /**
       * `['posts', ':postId', 'comments', ':commentId']` -> 4 parts of a route.
       */
      const countPartOfRoute = splitedRoute.length;

      if (countPartOfUrl > countPartOfRoute) {
        (route.children || []).forEach((child) => setRouteDryMatch(child, pathOfRoute, routes));
        return;
      } else if (countPartOfUrl < countPartOfRoute - 1) {
        // URL not matched to defined route path.
        return;
      } else if (countPartOfUrl == countPartOfRoute - 1) {
        const lastElement = splitedRoute.pop() || '';
        if (lastElement.charAt(0) == ':') {
          lastPrimaryKey = lastElement.slice(1);
        } else {
          // URL not matched to defined route path.
          return;
        }
      } else {
        // countPartOfUrl == countPartOfRoute
        const lastElement = splitedRoute[splitedRoute.length - 1];
        if (lastElement.charAt(0) == ':') {
          hasLastRestId = true;
          lastPrimaryKey = lastElement.slice(1);
        }
      }

      routeDryMatch.push({ splitedUrl, splitedRoute, hasLastRestId, lastPrimaryKey, routes });
    }
  }

  /**
   * Takes result of dry matching an URL to a route path,
   * so length of `splitedUrl` is always must to be equal to length of `splitedRoute`.
   *
   * This method checks that concated `splitedUrl` is matched to concated `splitedRoute`;
   */
  protected getChainParams({
    splitedUrl,
    splitedRoute,
    hasLastRestId,
    lastPrimaryKey,
    routes,
  }: RouteDryMatch): ChainParam[] | void {
    const chainParams: ChainParam[] = [];
    const partsOfUrl: string[] = [];
    const partsOfRoute: string[] = [];

    /**
     * Here `splitedRoute` like this: `['posts', ':postId', 'comments', ':commentId']`.
     */
    splitedRoute.forEach((part, i) => {
      if (part.charAt(0) == ':') {
        const restId = splitedUrl[i] || undefined;
        const primaryKey = part.slice(1);
        /**
         * cacheKey should be without a restId at the end of URL, e.g. `posts` or `posts/123/comments`,
         * but not `posts/123` or `posts/123/comments/456`.
         */
        const cacheKey = splitedUrl.slice(0, i).join('/');
        const route = routes[chainParams.length];
        chainParams.push({ cacheKey, primaryKey, restId, route });
      } else {
        /**
         * Have result of transformations like this:
         * - `['posts', '123']` -> `['posts']`
         * - or `['posts', '123', 'comments', '456']` -> `['posts', 'comments']`.
         */
        partsOfUrl.push(splitedUrl[i]);
        /**
         * Have result of transformations like this:
         * - `['posts', ':postId']` -> `['posts']`
         * - or `['posts', ':postId', 'comments', ':commentId']` -> `['posts', 'comments']`.
         */
        partsOfRoute.push(part);
      }
    });

    if (!hasLastRestId) {
      const lastRoute = routes[routes.length - 1];
      chainParams.push({ cacheKey: splitedUrl.join('/'), primaryKey: lastPrimaryKey || '', route: lastRoute });
    }

    if (partsOfRoute.join('/') == partsOfUrl.join('/')) {
      // Signature of a route path is matched to an URL.
      return chainParams;
    }
  }

  protected getQueryParams(req: HttpRequest<any>) {
    const keys = req.params.keys();
    if (!keys.length) {
      return undefined;
    }
    const queryParams: ObjectAny = {};
    keys.forEach((key) => {
      const values = req.params.getAll(key);
      queryParams[key] = values && values.length == 1 ? values[0] : values;
    });
    return queryParams;
  }

  /**
   * This function:
   * - calls `dataCallback()` from apropriate route;
   * - calls `responseCallback()` from matched route and returns a result.
   */
  protected sendResponse(req: HttpRequest<any>, chainParams: ChainParam[]): Observable<HttpResponse<any>> {
    const queryParams = this.getQueryParams(req);
    const httpMethod = req.method as HttpMethod;
    /** Last chain param */
    const chainParam = chainParams[chainParams.length - 1];
    const parents = this.getParents(req, chainParams);

    /**
     * Here we may to have "Error 404: item not found".
     */
    if (parents instanceof HttpErrorResponse) {
      return throwError(parents);
    }

    let responseOptions = {} as HttpErrorResponse | ResponseOptions;

    if (chainParam.route.dataCallback) {
      const mockData = this.cacheDataWithGetMethod(chainParam, parents, queryParams, req.body, req.headers);
      responseOptions = this.callRequestMethod(req, chainParam, mockData);

      if (responseOptions instanceof HttpErrorResponse) {
        return throwError(responseOptions);
      }

      if (httpMethod != 'GET') {
        const opts: ApiMockDataCallbackOptions = {
          items: mockData.writeableData,
          itemId: chainParam.restId,
          httpMethod,
          parents,
          queryParams,
          reqBody: req.body,
          reqHeaders: this.transformHeaders(req.headers),
        };
        const writeableData = chainParam.route.dataCallback(opts);

        this.cachedData[chainParam.cacheKey] = { writeableData, readonlyData: [] };
        this.bindReadonlyData(chainParam, writeableData);
        if (this.config.cacheFromLocalStorage) {
          this.setToLocalStorage(chainParam.cacheKey);
        }
      }
    }

    return this.getResponse(req, chainParam, parents, queryParams, responseOptions as ResponseOptions);
  }

  /**
   * If cached data no exists, calls `dataCallback()` with `GET` HTTP method,
   * cache the result and returns it.
   */
  protected cacheDataWithGetMethod(
    chainParam: ChainParam,
    parents?: ObjectAny[],
    queryParams?: Params,
    body?: any,
    headers?: HttpHeaders
  ) {
    if (this.config.cacheFromLocalStorage && !chainParam.route.ignoreDataFromLocalStorage) {
      this.applyDataFromLocalStorage(chainParam);
    }

    if (!this.cachedData[chainParam.cacheKey]) {
      const opts: ApiMockDataCallbackOptions = {
        items: [],
        itemId: chainParam.restId,
        httpMethod: 'GET',
        parents,
        queryParams,
        reqBody: body,
        reqHeaders: this.transformHeaders(headers),
      };
      const writeableData = (chainParam.route.dataCallback && chainParam.route.dataCallback(opts)) || [];
      if (!Array.isArray(writeableData)) {
        throw new TypeError('route.dataCallback() should returns an array');
      }
      this.cachedData[chainParam.cacheKey] = { writeableData, readonlyData: [] };
      this.bindReadonlyData(chainParam, writeableData);

      if (this.config.cacheFromLocalStorage) {
        this.setToLocalStorage(chainParam.cacheKey);
      }
    }

    return this.cachedData[chainParam.cacheKey];
  }

  protected applyDataFromLocalStorage(chainParam: ChainParam): void {
    try {
      const cachedData: CacheData = JSON.parse(localStorage.getItem(this.config.localStorageKey!) || '""');
      const cacheKey = chainParam.cacheKey;
      if (cachedData && cachedData[cacheKey]) {
        const mockData = (this.cachedData[cacheKey] = cachedData[cacheKey]);
        this.bindReadonlyData(chainParam, mockData.writeableData);
      }
    } catch (err) {
      localStorage.removeItem(this.config.localStorageKey!);
      if (this.config.showLog) {
        console.log(err);
        console.log(`%cRemoved localStorage data with key "${this.config.localStorageKey}"`, `color: brown;`);
      }
    }
  }

  protected setToLocalStorage(cacheKey: string): void {
    try {
      const cachedData = JSON.parse(localStorage.getItem(this.config.localStorageKey!) || '""') || {};
      cachedData[cacheKey] = this.clone(this.cachedData[cacheKey]);
      delete cachedData[cacheKey].readonlyData;
      localStorage.setItem(this.config.localStorageKey!, JSON.stringify(cachedData));
    } catch (err) {
      localStorage.removeItem(this.config.localStorageKey!);
      if (this.config.showLog) {
        console.log(err);
        console.log(`%cRemoved localStorage data with key "${this.config.localStorageKey}"`, `color: brown;`);
      }
    }
  }

  protected getParents(req: HttpRequest<any>, chainParams: ChainParam[]): ObjectAny[] | HttpErrorResponse | undefined {
    const queryParams = this.getQueryParams(req);
    const parents: ObjectAny[] = [];

    // for() without last chainParam.
    for (let i = 0; i < chainParams.length - 1; i++) {
      const chainParam = chainParams[i];
      const currParents = parents.length ? parents : undefined;
      const mockData = this.cacheDataWithGetMethod(chainParam, currParents, queryParams, req.body, req.headers);
      const primaryKey = chainParam.primaryKey;
      const restId = chainParam.restId;
      const item = mockData.writeableData.find((obj) => obj[primaryKey] && obj[primaryKey] == restId);

      if (!item) {
        const message = `Error 404: item.${primaryKey}=${restId} not found, searched in:`;
        this.logErrorResponse(req, message, mockData.writeableData);

        return this.makeError(req, Status.NOT_FOUND, 'item not found');
      }

      parents.push(item);
    }

    return parents.length ? parents : undefined;
  }

  protected callRequestMethod(
    req: HttpRequest<any>,
    chainParam: ChainParam,
    mockData: MockData
  ): ResponseOptions | HttpErrorResponse {
    const httpMethod = req.method as HttpMethod;
    const headers = new HttpHeaders({ 'Content-Type': 'application/json' });

    switch (httpMethod) {
      case 'GET':
        return this.get(req, headers, chainParam, mockData);
      case 'POST':
        return this.post(req, headers, chainParam, mockData.writeableData);
      case 'PUT':
      case 'PATCH':
        return this.putOrPatch(req, headers, chainParam, mockData.writeableData);
      case 'DELETE':
        return this.delete(req, headers, chainParam, mockData.writeableData);
      default:
        const errMsg = 'Error 405: Method not allowed';
        this.logErrorResponse(req, errMsg);
        return this.makeError(req, Status.METHOD_NOT_ALLOWED, errMsg);
    }
  }

  protected get(
    req: HttpRequest<any>,
    headers: HttpHeaders,
    chainParam: ChainParam,
    mockData: MockData
  ): ResponseOptions | HttpErrorResponse {
    const primaryKey = chainParam.primaryKey;
    const restId = chainParam.restId;
    let body: ObjectAny[] = [];

    if (restId !== undefined) {
      const item = mockData.writeableData.find((obj) => obj[primaryKey] && obj[primaryKey] == restId);

      if (!item) {
        const message = `Error 404: item.${primaryKey}=${restId} not found, searched in:`;
        this.logErrorResponse(req, message, mockData.writeableData);

        return this.makeError(req, Status.NOT_FOUND, 'item not found');
      }
      body = [item];
    } else {
      body = mockData.readonlyData;
    }

    return { status: Status.OK, headers, body };
  }

  /**
   * Create entity, but can update an existing entity too
   * if `config.postUpdate409 = false` (by default).
   */
  protected post(
    req: HttpRequest<any>,
    headers: HttpHeaders,
    chainParam: ChainParam,
    writeableData: ObjectAny[]
  ): ResponseOptions | HttpErrorResponse {
    const item: ObjectAny = this.clone(req.body || {});
    const { primaryKey, restId } = chainParam;
    const resourceUrl = restId ? req.url.split('/').slice(0, -1).join('/') : req.url;

    if (restId != undefined) {
      const errMsg = `Error 405: Method not allowed; POST forbidder on this URI, try on "${resourceUrl}"`;
      this.logErrorResponse(req, errMsg);
      return this.makeError(req, Status.METHOD_NOT_ALLOWED, errMsg);
    }

    if (!primaryKey) {
      const errMsg = `Error 400: Bad Request; POST forbidder on URI without primary key in the route`;
      this.logErrorResponse(req, errMsg);
      return this.makeError(req, Status.BAD_REQUEST, errMsg);
    }

    if (item[primaryKey] === undefined) {
      item[primaryKey] = this.genId(writeableData, primaryKey);
    }

    const id = item[primaryKey];
    const itemIndex = writeableData.findIndex((itm: any) => itm[primaryKey] == id);

    if (itemIndex == -1) {
      writeableData.push(item);
      const clonedHeaders = headers.set('Location', `${resourceUrl}/${id}`);
      return { headers: clonedHeaders, body: item, status: Status.CREATED };
    } else if (this.config.postUpdate409) {
      const errMsg = `Error 409: Conflict; item.${primaryKey}=${id} exists and may not be updated with POST; use PUT instead.`;
      this.logErrorResponse(req, errMsg);
      return this.makeError(req, Status.CONFLICT, errMsg);
    } else {
      writeableData[itemIndex] = item;
      return this.config.postUpdate204
        ? { headers, status: Status.NO_CONTENT } // successful; no content
        : { headers, body: item, status: Status.OK }; // successful; return entity
    }
  }

  protected putOrPatch(
    req: HttpRequest<any>,
    headers: HttpHeaders,
    chainParam: ChainParam,
    writeableData: ObjectAny[]
  ): ResponseOptions | HttpErrorResponse {
    const update204 = req.method == 'PUT' ? this.config.putUpdate204 : this.config.patchUpdate204;
    const item: ObjectAny = this.clone(req.body || {});
    const { primaryKey, restId } = chainParam;

    if (!primaryKey) {
      const errMsg = `Error 400: Bad Request; ${req.method} forbidder on URI without primary key in the route`;
      this.logErrorResponse(req, errMsg);
      return this.makeError(req, Status.BAD_REQUEST, errMsg);
    }

    if (item[primaryKey] == undefined) {
      item[primaryKey] = restId;
    }

    if (restId == undefined) {
      const errMsg = `Error 405: Method not allowed; ${req.method} forbidder on this URI, try on "${req.url}/:${primaryKey}"`;
      this.logErrorResponse(req, errMsg);
      return this.makeError(req, Status.METHOD_NOT_ALLOWED, errMsg);
    }

    if (restId != item[primaryKey]) {
      const errMsg =
        `Error 400: Bad request; request with resource ID ` +
        `"${restId}" does not match item.${primaryKey}=${item[primaryKey]}`;
      this.logErrorResponse(req, errMsg);
      return this.makeError(req, Status.BAD_REQUEST, errMsg);
    }

    const itemIndex = writeableData.findIndex((itm: any) => itm[primaryKey] == restId);

    if (itemIndex != -1) {
      if (req.method == 'PUT') {
        const keysFromNewItem = Object.keys(item);
        Object.keys(writeableData[itemIndex]).forEach((k) => {
          if (!keysFromNewItem.includes(k)) {
            delete writeableData[itemIndex][k];
          }
        });
      }
      Object.assign(writeableData[itemIndex], item);
      return update204
        ? { headers, status: Status.NO_CONTENT } // successful; no content
        : { headers, body: item, status: Status.OK }; // successful; return entity
    } else if (this.config.putUpdate404 || req.method == 'PATCH') {
      const errMsg =
        `Error 404: Not found; item.${primaryKey}=${restId} ` +
        `not found and may not be created with ${req.method}; use POST instead.`;
      this.logErrorResponse(req, errMsg);
      return this.makeError(req, Status.NOT_FOUND, errMsg);
    } else {
      // create new item for id that not found
      writeableData.push(item);
      return { headers, body: item, status: Status.CREATED };
    }
  }

  protected delete(
    req: HttpRequest<any>,
    headers: HttpHeaders,
    chainParam: ChainParam,
    writeableData: ObjectAny[]
  ): ResponseOptions | HttpErrorResponse {
    const { primaryKey, restId: id } = chainParam;

    if (!primaryKey) {
      const errMsg = `Error 400: Bad Request; DELETE forbidder on URI without primary key in the route`;
      this.logErrorResponse(req, errMsg);
      return this.makeError(req, Status.BAD_REQUEST, errMsg);
    }

    let itemIndex = -1;
    if (id != undefined) {
      itemIndex = writeableData.findIndex((itemLocal: any) => itemLocal[primaryKey] == id);
    }

    if (id == undefined || (itemIndex == -1 && this.config.deleteNotFound404)) {
      let errMsg = 'Error 404: Not found; ';
      errMsg += id ? `item.${primaryKey}=${id} not found` : `missing "${primaryKey}" field`;
      this.logErrorResponse(req, errMsg);
      return this.makeError(req, Status.NOT_FOUND, errMsg);
    }

    if (itemIndex != -1) {
      writeableData.splice(itemIndex, 1);
    }

    return { headers, status: Status.NO_CONTENT };
  }

  protected getResponse(
    req: HttpRequest<any>,
    chainParam: ChainParam,
    parents: (ObjectAny[] | undefined),
    queryParams?: Params,
    responseOptions: ResponseOptions = {} as any
  ): Observable<HttpResponse<any>> {
    /** The body should be always an array. */
    let body: any[] = [];
    const anyBody: any = responseOptions.body;
    if (anyBody !== undefined) {
      body = Array.isArray(anyBody) ? anyBody : [anyBody];
    }

    const restId = chainParam.restId;
    const httpMethod = req.method as HttpMethod;
    const clonedBody: any[] = this.clone(body);
    /**
     * Response or value of a body for response.
     */
    let resOrBody = clonedBody;

    if (chainParam.route.responseCallback) {
      const opts: ApiMockResponseCallbackOptions = {
        items: clonedBody,
        itemId: restId,
        httpMethod,
        parents: this.clone(parents),
        queryParams,
        reqBody: this.clone(req.body),
        reqHeaders: this.transformHeaders(req.headers),
        resBody: responseOptions.body,
      };
      resOrBody = chainParam.route.responseCallback(opts);
    }

    let observable: Observable<HttpResponse<any>>;

    if (resOrBody instanceof HttpErrorResponse) {
      this.logErrorResponse(req, resOrBody);
      observable = throwError(resOrBody);
    } else if (resOrBody instanceof HttpResponse) {
      observable = of(resOrBody);
    } else {
      responseOptions.status = responseOptions.status || Status.OK;
      responseOptions.body = resOrBody;
      observable = of(new HttpResponse(responseOptions));

      let logHeaders: ObjectAny | undefined = {};
      if (responseOptions.headers instanceof HttpHeaders) {
        logHeaders = this.transformHeaders(responseOptions.headers);
      } else if (responseOptions.headers) {
        logHeaders = responseOptions.headers;
      }

      const resLog: ResponseOptionsLog = {
        headers: logHeaders,
        status: responseOptions.status,
        body: resOrBody,
      };
      this.logSuccessResponse(req, resLog);
    }

    return observable.pipe(delay(this.config.delay!));
  }

  /**
   * Generator of the next available id for item in this collection.
   *
   * @param writeableData - collection of items
   * @param primaryKey - a primaryKey of the collection
   */
  protected genId(writeableData: ObjectAny[], primaryKey: string): number {
    const maxId = writeableData.reduce((prevId: number, item: ObjectAny) => {
      const currId = typeof item[primaryKey] == 'number' ? item[primaryKey] : prevId;
      return Math.max(prevId, currId);
    }, 0);

    return maxId + 1;
  }

  protected send404Error(req: HttpRequest<any>) {
    if (this.config.passThruUnknownUrl) {
      return new HttpXhrBackend(this.xhrFactory).handle(req);
    }

    const errMsg = 'Error 404: Not found';
    this.logErrorResponse(req, errMsg);
    const err = this.makeError(req, Status.NOT_FOUND, errMsg);

    return throwError(err);
  }

  protected logRequest(req: HttpRequest<any>) {
    let logHeaders: ObjectAny | undefined;
    let queryParams: ObjectAny | undefined;
    let body: any;
    try {
      logHeaders = this.transformHeaders(req.headers);
      queryParams = this.getQueryParams(req);
      if (isFormData(req.body)) {
        body = [];
        req.body.forEach((value, key) => body.push({ [key]: value }));
      } else {
        body = req.body;
      }
    } catch (err: any) {
      logHeaders = { parseError: err.message || 'error' };
      queryParams = { parseError: err.message || 'error' };
    }

    let log: {
      headers?: ObjectAny;
      queryParams?: ObjectAny;
      body?: ObjectAny;
    } = {};
    if (logHeaders !== undefined) {
      log.headers = logHeaders;
    }
    if (queryParams !== undefined) {
      log.queryParams = queryParams;
    }
    if (body !== undefined) {
      log.body = body;
    }
    if (JSON.stringify(log) == '{}') {
      log = '' as any;
    }

    console.log(`%creq: ${req.method} ${req.url}`, 'color: green;', log);

    // returns for tests only
    return log;
  }

  protected logResponse(res: ResponseOptionsLog) {
    if (res.headers && !Object.keys(res.headers).length) {
      delete res.headers;
    }
    if (res.body && !Object.keys(res.body).length) {
      delete res.body;
    }
    console.log('%cres:', `color: blue;`, res);
  }

  protected logSuccessResponse(req: HttpRequest<any>, res: ResponseOptionsLog) {
    if (!this.config.showLog) {
      return;
    }

    this.logRequest(req);
    this.logResponse(res);
  }

  protected logErrorResponse(req: HttpRequest<any>, ...consoleArgs: any[]) {
    if (!this.config.showLog) {
      return;
    }

    this.logRequest(req);
    console.log('%cres:', `color: brown;`, ...consoleArgs);
  }

  protected transformHeaders(headers?: HttpHeaders) {
    if (!headers || !headers.keys().length) {
      return undefined;
    }
    const logHeaders: ObjectAny = {};
    headers.keys().forEach((header) => {
      let values = headers.getAll(header);
      logHeaders[header] = values && values.length == 1 ? values[0] : values;
    });
    return logHeaders;
  }

  protected clone(data: any) {
    return data === undefined ? undefined : JSON.parse(JSON.stringify(data));
  }

  protected makeError(req: HttpRequest<any>, status: Status, errMsg: string) {
    return new HttpErrorResponse({
      url: req.urlWithParams,
      status,
      statusText: getStatusText(status),
      headers: new HttpHeaders({ 'Content-Type': 'application/json' }),
      error: errMsg,
    });
  }

  /**
   * Setting readonly data to `this.cachedData[cacheKey].readonlyData`
   */
  protected bindReadonlyData(chainParam: ChainParam, writeableData: ObjectAny[]) {
    let readonlyData: ObjectAny[];
    const pickObj = chainParam.route.propertiesForList;
    if (pickObj) {
      readonlyData = writeableData.map((d) => pickAllPropertiesAsGetters(this.clone(pickObj), d));
    } else {
      readonlyData = writeableData.map((d) => pickAllPropertiesAsGetters(d));
    }
    this.cachedData[chainParam.cacheKey].readonlyData = readonlyData;
  }
}
