let AuthApi = require('./users/AuthApi');
let ClientError = require('./ClientError');

class Api {
  async addAsync(...args) {
    let sum = 0;
    for (let x of args) {
      sum += x;
    }
    return sum;
  }

  async loginAsync(username, password) {
    // Don't log passwords in cleartext!
    this._logArgs = [username, 'XXXXXX'];

    let result = await this._authApi().loginAsync(username, password);

    return result;
  }

  _authApi() {
    let authApi = new AuthApi();
    authApi.context = { ...this.context };
    return authApi;
  }

  async logoutAsync() {
    let sessionSecret = this.context.sessionSecret;
    let result = {};
    if (!sessionSecret) {
      // console.warn('No current session to logout of; no-oping.');
      this.responseAddWarning('NOT_LOGGED_IN', 'No current session to logout of');
      return;
    }
    return await this._authApi().logoutAsync(sessionSecret);
  }

  async profileAsync() {
    return await this._authApi().profileAsync();
  }

  async signupAsync(userInfo) {
    return await this._authApi().signupAsync(userInfo);
  }
}

module.exports = Api;
