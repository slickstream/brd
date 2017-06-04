import fs = require('fs');
import * as express from "express";
import { Express, Request, Response } from 'express';
import net = require('net');
import http = require('http');
import https = require('https');
import Mustache = require('mustache');
import * as compression from "compression";
import * as bodyParser from "body-parser";
import * as cookieParser from "cookie-parser";
import * as path from "path";
import { config } from "./config";
import { RestServiceRegistrar, RestServiceHandler, RestServiceResult, RestServer } from "./interfaces/rest-server";
import { Context } from "./interfaces/context";
import { logger } from "./utils/logger";
import { utils } from "./utils/utils";
import { Initializable } from "./interfaces/initializable";
import { Startable } from "./interfaces/startable";
import { ExecutionContext } from "./execution-context";
import { emailManager } from "./email-manager";
import { database } from "./db";
import { waitingListManager } from "./waiting-list-manager";
import { userManager, UserSignoutHandler } from "./user-manager";
import { servicesRestServer } from "./services-rest-server";
import { googleProvider } from "./providers/google/google-provider";
import { gmailService } from "./providers/google/gmail-service";
import { googleDriveService } from "./providers/google/google-drive-service";
import { servicesManager } from "./services-manager";
import { rootPageHandler } from "./page-handlers/root-handler";
import { userRestServer } from "./user-rest-server";
import { urlManager } from "./url-manager";
import { ServiceHandler, ClientMessage, ClientMessageDeliverer } from "./interfaces/service-provider";
import { clock } from "./utils/clock";
import WebSocket = require('ws');

interface ExpressAppWithWebsocket extends express.Application {
  ws: (path: string, callback: (ws: WebSocket, request: Request) => void) => void;
}
export class Server implements RestServiceRegistrar, ClientMessageDeliverer, UserSignoutHandler {

  private version = Date.now();
  private running = false;
  private app: ExpressAppWithWebsocket;
  private redirectContent: string;
  private maxAge = 86400000;
  private clientServer: net.Server;
  private restServers: RestServer[] = [rootPageHandler, waitingListManager, userRestServer, servicesRestServer, googleProvider, gmailService, googleDriveService];
  private initializables: Initializable[] = [rootPageHandler, emailManager, database];
  private startables: Startable[] = [googleProvider, servicesManager];
  private serviceHandlers: ServiceHandler[] = [gmailService, googleDriveService];
  private serverStatus = 'starting';
  private expressWs: any;
  private activeSocketsByUser: { [userId: string]: WebSocket[] } = {};

  async start(context: Context): Promise<void> {
    process.on('unhandledRejection', (reason: any) => {
      logger.error(context, 'server', "Unhandled Rejection!", JSON.stringify(reason), reason.stack);
    });

    process.on('uncaughtException', (err: any) => {
      logger.error(context, 'server', "Unhandled Exception!", err.toString(), err.stack);
    });

    this.initialize(context);
    for (const initializable of this.initializables) {
      await initializable.initialize(context);
    }
    userManager.registerSignoutHandler(context, this);

    await this.startServer(context);
    for (const startable of this.startables) {
      await startable.start(context);
    }
    this.serverStatus = 'OK';
  }

  private initialize(context: Context): void {
    const templatePath = path.join(__dirname, '../templates/redirect.html');
    this.redirectContent = fs.readFileSync(templatePath, 'utf8');
    googleProvider.registerClientMessageDeliveryService(context, this);
  }

  private async startServer(context: Context) {
    if (context.getConfig('client.maxAge')) {
      this.maxAge = context.getConfig('client.maxAge');
    }
    this.app = (express() as any) as ExpressAppWithWebsocket;

    this.app.use(compression());
    this.app.use(bodyParser.json()); // for parsing application/json
    this.app.use(bodyParser.urlencoded({
      extended: true
    }));
    this.app.use(cookieParser());

    await this.registerHandlers(context);
    for (const restServer of this.restServers) {
      await restServer.initializeRestServices(context, this);
    }

    this.app.use(urlManager.getPublicBaseUrl(context), express.static(path.join(__dirname, '../public'), { maxAge: 1000 * 60 * 60 * 24 * 7 }));
    this.app.use(urlManager.getStaticBaseUrl(context), express.static(path.join(__dirname, "../static"), { maxAge: 1000 * 60 * 60 * 24 * 7 }));

    if (!context.getConfig('client.ssl')) {
      logger.log(context, "server", "startServer", "Using unencrypted client connections");
      this.clientServer = http.createServer(this.app);
    } else {
      logger.log(context, "server", "startServer", "Using encrypted client connections");
      const privateKey = fs.readFileSync(context.getConfig('ssl.key'), 'utf8');
      const certificate = fs.readFileSync(context.getConfig('ssl.cert'), 'utf8');
      const credentials: any = {
        key: privateKey,
        cert: certificate
      };
      const ca = this.getCertificateAuthority(context);
      if (ca) {
        credentials.ca = ca;
      }
      this.clientServer = https.createServer(credentials, this.app);
    }
    this.clientServer.listen(context.getConfig('client.port'), (err: any) => {
      if (err) {
        console.error("Failure listening", err);
        process.exit();
      } else {
        logger.log(context, "server", "startServer", "Listening for client connections on port " + context.getConfig('client.port'));
      }
    });
    this.handleWebsockets(context);
  }

  private handleWebsockets(context: Context): void {
    this.expressWs = require('express-ws')(this.app, this.clientServer);
    let pingPongInterval = context.getConfig('client.pingPongInterval', 10000) as number;
    if (pingPongInterval === 0) {
      pingPongInterval = 1000 * 60 * 60 * 24;
    }
    this.app.ws('/d/client', (ws: WebSocket, request: Request) => {
      let lastPong = clock.now() + pingPongInterval / 2;
      const timer = clock.setInterval(() => {
        if (clock.now() - lastPong > pingPongInterval) {
          logger.log(context, 'server', 'handleWebsockets', 'Client socket being closed because of ping-pong timeout');
          ws.close();
        } else {
          ws.send('__ping__');
        }
      }, pingPongInterval);
      ws.on('message', (message: any) => {
        if (message && typeof message === 'string') {
          if (message === '__pong__') {
            lastPong = clock.now();
          } else {
            void this.handleWebsocketMessage(context.getConfigData(), ws, request, message);
          }
        } else {
          console.warn("Invalid message received on socket", message);
        }
      });
      ws.on('close', () => {
        clock.clearInterval(timer);
        void this.handleWebsocketClose(context.getConfigData(), ws, request);
      });
    });
  }

  private registerClientSocket(context: Context, ws: WebSocket): void {
    if (context.user) {
      let socketList: WebSocket[] = [];
      socketList = this.activeSocketsByUser[context.user.id];
      if (!socketList) {
        socketList = [];
        this.activeSocketsByUser[context.user.id] = socketList;
      }
      socketList.push(ws);
    }
  }

  private unregisterClientSocket(context: Context, ws: WebSocket): void {
    if (context.user) {
      const socketList = this.activeSocketsByUser[context.user.id];
      if (socketList && socketList.indexOf(ws) >= 0) {
        if (socketList.length > 1) {
          socketList.splice(socketList.indexOf(ws), 1);
        } else {
          delete this.activeSocketsByUser[context.user.id];
        }
      }
    }
  }

  private async handleWebsocketMessage(parentContextData: any, ws: WebSocket, request: Request, message: string): Promise<void> {
    let error: any;
    const context = new ExecutionContext('ws-message', parentContextData);
    context.websocket = ws;
    await userManager.onWebsocketEvent(context, ws, request);
    try {
      const msg = JSON.parse(message) as ClientMessage;
      if (!msg || !msg.type) {
        throw new Error("Unexpected or invalid message: " + JSON.stringify(message));
      }
      if (msg.type === 'open') {
        if (msg.details && msg.details.userId) {
          await userManager.onWebsocketOpenRequest(context, ws, msg.details.userId);
          if (context.user) {
            this.registerClientSocket(context, ws);
            const response: ClientMessage = {
              type: 'open-success'
            };
            await this.deliverMessage(context, { type: 'open-success' }, false);
          }
        } else {
          logger.warn(context, 'server', 'handleWebsocketMessage', 'Invalid client open message', msg);
          await this.deliverMessage(context, { type: 'open-failed', details: { message: 'No such user' } }, false);
        }
      } else if (msg.serviceId && msg.accountId) {
        if (context.user) {
          for (const handler of this.serviceHandlers) {
            if (handler.serviceId === msg.serviceId) {
              await handler.handleClientCardMessage(context, msg);
            }
          }
        } else {
          logger.warn(context, 'server', 'handleWebsocketMessage', 'Unexpected card client message when no current user');
        }
      } else {
        if (context.user) {
          await this.handleClientAppMessage(context, msg);
        } else {
          logger.warn(context, 'server', 'handleWebsocketMessage', 'Unexpected app client message when no current user');
        }
      }
    } catch (err) {
      console.warn("Exception handling client message", err);
      error = err;
    } finally {
      await context.finish(error);
    }
  }

  private async handleClientAppMessage(context: Context, message: ClientMessage): Promise<void> {
    console.log("Client App message received", message);
  }

  private async handleWebsocketClose(parentContextData: any, ws: any, request: Request): Promise<void> {
    let error: any;
    const context = new ExecutionContext('ws-close', parentContextData);
    logger.log(context, 'server', 'handleWebsocketClose', 'Client socket closed');
    await userManager.onWebsocketEvent(context, ws, request);
    this.unregisterClientSocket(context, ws);
    try {
      for (const handler of this.serviceHandlers) {
        await handler.handleClientSocketClosed(context);
      }
    } catch (err) {
      error = err;
    } finally {
      await context.finish(error);
    }
  }

  private registerHandlers(context: Context) {
    this.registerHandler(context, this.handlePingRequest.bind(this), 'get', '/ping', false, false);
  }

  private async handlePingRequest(context: Context, request: Request, response: Response): Promise<RestServiceResult> {
    response.setHeader('Cache-Control', 'no-cache, no-store, max-age=0, must-revalidate');
    response.setHeader('Content-Type', 'application/json');
    const result: any = {
      product: 'Braid',
      status: 'OK',
      version: context.getConfig('version'),
      deployed: new Date(this.version).toISOString(),
      server: context.getConfig('serverId')
    };
    return new RestServiceResult(result);
  }

  registerHandler(context: Context, handler: RestServiceHandler, action: string, suffix: string, dynamic: boolean, cacheable: boolean): void {
    switch (action) {
      case 'get':
        this.registerGet(context, handler, suffix, dynamic, cacheable);
        break;
      case 'put':
        this.registerPut(context, handler, suffix, dynamic, cacheable);
        break;
      case 'post':
        this.registerPost(context, handler, suffix, dynamic, cacheable);
        break;
      case 'delete':
        this.registerDelete(context, handler, suffix, dynamic, cacheable);
        break;
      default:
        throw new Error("Unsupported HTTP action " + action);
    }
  }

  private getCertificateAuthority(context: Context): string[] {
    let ca: string[];
    if (context.getConfig('ssl.ca')) {
      ca = [];
      const chain = fs.readFileSync(context.getConfig('ssl.ca'), 'utf8');
      const chains = chain.split("\n");
      let cert: string[] = [];
      for (const line of chains) {
        if (line.length > 0) {
          cert.push(line);
          if (line.match(/-END CERTIFICATE-/)) {
            ca.push(cert.join('\n'));
            cert = [];
          }
        }
      }
    }
    return ca;
  }

  private registerGet(context: Context, handler: RestServiceHandler, suffix: string, dynamic: boolean, cacheable: boolean, contentType?: string): void {
    this.app.get((dynamic ? urlManager.getDynamicBaseUrl(context) : '') + suffix, (request, response) => {
      void this.handleHttpRequest(context, request, response, handler, cacheable, contentType).then(() => {
        // noop
      });
    });
  }

  private registerPut(context: Context, handler: RestServiceHandler, suffix: string, dynamic: boolean, cacheable: boolean): void {
    this.app.put((dynamic ? urlManager.getDynamicBaseUrl(context) : '') + suffix, (request, response) => {
      void this.handleHttpRequest(context, request, response, handler, cacheable).then(() => {
        // noop
      });
    });
  }

  private registerPost(context: Context, handler: RestServiceHandler, suffix: string, dynamic: boolean, cacheable: boolean): void {
    this.app.post((dynamic ? urlManager.getDynamicBaseUrl(context) : '') + suffix, (request, response) => {
      void this.handleHttpRequest(context, request, response, handler, cacheable).then(() => {
        // noop
      });
    });
  }

  private registerDelete(context: Context, handler: RestServiceHandler, suffix: string, dynamic: boolean, cacheable: boolean): void {
    this.app.delete((dynamic ? urlManager.getDynamicBaseUrl(context) : '') + suffix, (request, response) => {
      void this.handleHttpRequest(context, request, response, handler, cacheable).then(() => {
        // noop
      });
    });
  }

  private async handleHttpRequest(parentContext: Context, request: Request, response: Response, handler: RestServiceHandler, cacheable: boolean, contentType?: string): Promise<void> {
    const context = new ExecutionContext('http', parentContext.getConfigData());
    try {
      if (!cacheable) {
        response.setHeader('Cache-Control', 'no-cache, no-store, max-age=0, must-revalidate');
      }
      const doNotHandle = await this.initializeHttpContext(context, request, response);
      if (!doNotHandle) {
        const result = await handler(context, request, response);
        if (result.redirectUrl) {
          response.redirect(result.redirectUrl);
          // this.redirectToUrl(context, request, response, result.redirectUrl);
        } else if (result.json) {
          response.json(result.json);
        } else {
          if (contentType) {
            response.contentType(contentType);
          }
          if (result.statusCode) {
            response.status(result.statusCode);
          } else {
            response.status(200);
          }
          if (result.message) {
            response.send(result.message);
          } else {
            response.end();
          }
        }
      }
      await context.finish();
    } catch (err) {
      logger.error(context, "server", "registerHttpHandler", "Exception", utils.logErrorObject(err));
      this.sendInternalError(context, request, response, err.toString());
      if (await context.finish(err)) {
        // throw err;
      }
    }
  }

  private async initializeHttpContext(context: Context, request: Request, response: Response) {
    context.serverId = context.getConfig('serverId');
    await userManager.initializeHttpContext(context, request, response);
  }

  private sendInternalError(context: Context, request: Request, response: Response, err: any) {
    response.setHeader('Content-Type', 'text/plain');
    response.status(500).send('Internal server error: ' + JSON.stringify(err));
  }

  private redirectToUrl(context: Context, request: Request, response: Response, toUrl: string) {
    const ogData = '';
    const view = {
      static_base: urlManager.getStaticBaseUrl(context),
      ogdata: ogData,
      url: toUrl,
      pageTitle: "Braid"
    };
    const output = Mustache.render(this.redirectContent, view);
    response.send(output);
  }

  async deliverMessage(context: Context, message: ClientMessage, multicast: boolean): Promise<void> {
    if (multicast) {
      if (context.user) {
        const socketList = this.activeSocketsByUser[context.user.id];
        if (socketList) {
          const serialized = JSON.stringify(message);
          for (const ws of socketList) {
            ws.send(serialized);
          }
        }
      }
    } else if (context.websocket) {
      context.websocket.send(JSON.stringify(message, null, context.getConfig('debug.messages.pretty') ? 3 : null));
    }
  }

  async onUserSignedOut(context: Context, userId: string): Promise<void> {
    const socketList = this.activeSocketsByUser[userId];
    if (socketList) {
      for (const ws of socketList) {
        ws.close();
      }
      delete this.activeSocketsByUser[userId];
    }
  }

}

const server = new Server();
export { server };
