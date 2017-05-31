import { RestServer, RestServiceRegistrar, RestServiceResult } from '../../interfaces/rest-server';
import { Request, Response } from 'express';
import { Context } from '../../interfaces/context';
import { googleUsers, GoogleUser, searchProviders } from "../../db";
import { SearchMatch, SearchResult } from "../../interfaces/search-match";
import { utils } from "../../utils/utils";
import { SearchProviderDescriptor, ProviderUserProfile, ProviderAccountProfile } from "../../interfaces/search-provider";
import { gmailSearcher } from "./gmail-searcher";
import { GoogleSearcher } from "./google-searcher";
import { googleDriveSearcher } from "./drive-searcher";
import { Startable } from "../../interfaces/startable";
import url = require('url');
import { urlManager } from "../../url-manager";

const googleBatch = require('google-batch');
const google = googleBatch.require('googleapis');
const dateParser = require('parse-date/silent');
const addrparser = require('address-rfc2822');

const PROVIDER_ID = 'com.hivepoint.google';

const CLIENT_ID = '465784242367-35slo3s2c649sos2r92t9kkhkqidm8vi.apps.googleusercontent.com';
const CLIENT_SECRET = 'HcxU0DLd_Uq0fegkYq92lrme';

const SERVICE_URL = '/svc/google';
const AUTH_URL = SERVICE_URL + '/auth';
const AUTH_CALLBACK_URL = SERVICE_URL + '/callback';

export class GoogleProvider implements RestServer, Startable {
  createOauthClient(context: Context, googleUser?: GoogleUser): any {
    const OAuth2 = google.auth.OAuth2;

    const result = new OAuth2(
      CLIENT_ID,
      CLIENT_SECRET,
      urlManager.getDynamicUrl(context, AUTH_CALLBACK_URL, true)
    );
    if (googleUser) {
      result.setCredentials(googleUser.tokens);
    }
    return result;
  }

  async initializeRestServices(context: Context, registrar: RestServiceRegistrar): Promise<void> {
    registrar.registerHandler(context, this.handleServiceProvider.bind(this), 'get', SERVICE_URL, true, false);
    registrar.registerHandler(context, this.handleServiceAuthRequest.bind(this), 'get', AUTH_URL, true, false);
    registrar.registerHandler(context, this.handleServiceAuthCallback.bind(this), 'get', AUTH_CALLBACK_URL, true, false);
    registrar.registerHandler(context, this.handleUserProfile.bind(this), 'get', SERVICE_URL + '/profile', true, false);
  }

  async start(context: Context): Promise<void> {
    await searchProviders.upsertRecord(context, PROVIDER_ID, urlManager.getDynamicUrl(context, SERVICE_URL, true), null);
  }

  async handleServiceProvider(context: Context, request: Request, response: Response): Promise<RestServiceResult> {
    const description: SearchProviderDescriptor = {
      id: PROVIDER_ID,
      name: 'Google',
      logoSquareUrl: urlManager.getStaticUrl(context, '/svcs/google/google.png'),
      authUrl: urlManager.getDynamicUrl(context, AUTH_URL, true),
      services: []
    };
    description.services.push(gmailSearcher.getDescriptor(context));
    description.services.push(googleDriveSearcher.getDescriptor(context));
    return new RestServiceResult(description);
  }

  async handleServiceAuthRequest(context: Context, request: Request, response: Response): Promise<RestServiceResult> {
    const braidUserId = request.query.braidUserId;
    if (!braidUserId) {
      return new RestServiceResult(null, 400, "Missing token param");
    }
    const callbackUrl = request.query.callback;
    if (!callbackUrl) {
      return new RestServiceResult(null, 400, "Missing callback param");
    }
    const serviceIdString = request.query.serviceIds;
    if (!serviceIdString) {
      return new RestServiceResult(null, 400, "Missing serviceIds param");
    }
    const serviceIds = serviceIdString.split(',');
    const services: GoogleSearcher[] = [];
    const scopes: string[] = ['https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/userinfo.profile'];
    const scopedServiceIds: string[] = [];
    for (const serviceId of serviceIds) {
      switch (serviceId.trim().toLowerCase()) {
        case gmailSearcher.getDescriptor(context).id:
          this.addScopes(scopes, gmailSearcher.getOauthScopes());
          scopedServiceIds.push(serviceId);
          break;
        case googleDriveSearcher.getDescriptor(context).id:
          this.addScopes(scopes, googleDriveSearcher.getOauthScopes());
          scopedServiceIds.push(serviceId);
          break;
        default:
          break;
      }
    }
    const oauthClient = this.createOauthClient(context);
    const url = oauthClient.generateAuthUrl({
      access_type: 'offline',
      scope: scopes,
      state: JSON.stringify({ braidUserId: braidUserId, services: scopedServiceIds, clientCallback: callbackUrl })
    });
    return new RestServiceResult(null, null, null, url);
  }

  private addScopes(scopes: string[], add: string[]): void {
    for (const a of add) {
      if (scopes.indexOf(a) < 0) {
        scopes.push(a);
      }
    }
  }

  async handleServiceAuthCallback(context: Context, request: Request, response: Response): Promise<RestServiceResult> {
    const code = request.query.code;
    if (!code) {
      return new RestServiceResult(null, 400, "Auth code is missing");
    }
    const stateString = request.query.state;
    const state = JSON.parse(stateString);
    if (!state || !state.braidUserId || !state.services) {
      return new RestServiceResult(null, 400, "State information is missing");
    }
    return new Promise<RestServiceResult>((resolve, reject) => {
      const oauthClient = this.createOauthClient(context);
      oauthClient.getToken(code, (err: any, tokens: any) => {
        if (err) {
          reject(err);
        } else {
          oauthClient.setCredentials(tokens);
          const oauth2 = google.oauth2('v2');
          oauth2.userinfo.get({ userId: 'me', auth: oauthClient }, (profileErr: any, profile: any) => {
            if (profileErr) {
              reject(profileErr);
            } else {
              void googleUsers.upsertRecord(context, state.braidUserId, profile.id, profile.email, profile, tokens, state.services).then(() => {
                resolve(new RestServiceResult(null, null, null, utils.appendUrlParam(state.clientCallback, 'accountId', profile.id)));
              });
            }
          });
        }
      });
    });
  }

  async handleUserProfile(context: Context, request: Request, response: Response): Promise<RestServiceResult> {
    const braidUserId = request.query.braidUserId;
    if (!braidUserId) {
      return new RestServiceResult(null, 400, "Missing userToken and/or id parameters");
    }
    const result: ProviderUserProfile = {
      providerId: PROVIDER_ID,
      braidUserId: braidUserId,
      accounts: []
    };
    const users = await googleUsers.findByBraidUserId(context, braidUserId);
    if (users.length === 0) {
      return new RestServiceResult(null, 404, "No matching Google user");
    }
    for (const user of users) {
      const account: ProviderAccountProfile = {
        accountId: user.googleUserId,
        name: user.profile.name,
        accountName: user.profile.email,
        imageUrl: user.profile.picture,
        serviceIds: user.serviceIds
      };
      result.accounts.push(account);
    }
    return new RestServiceResult(result);
  }

  private getEmailFromProfile(profile: any): string {
    if (profile && profile.emails) {
      for (const email of profile.emails) {
        if (email.type === 'account') {
          return email.value;
        }
      }
    }
    if (profile && profile.emails.length > 0) {
      return profile.emails[0].value;
    }
    return null;
  }
}

const googleProvider = new GoogleProvider();

export { googleProvider };