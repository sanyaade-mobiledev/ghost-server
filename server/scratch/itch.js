let fetch = require('node-fetch');

let db = require('../db');
let model = require('../model');
let gq = require('../testlib/gq');

let gqAsync = gq.withClientId('__shell__/addItch');

async function addItchGameAsync(url) {
  let response = await fetch(url);
  let body = await response.text();
  let iframeUrl = 'https:' + body.match(/(\/\/v6p9d9t4.ssl.hwcdn.net\/[^"&]*)/)[1];
  let username = url.match(/https?:\/\/([a-z0-9-]+)\.itch\.io\/.*/)[1];

  await addItchUserAsync(username);

  return {
    iframeUrl,
    body,
  };
}

async function addItchUserAsync(itchUsername) {
  let username = itchUsername;
  let userId = 'user:itch+' + itchUsername;
  let name = itchUsername + ' on itch.io';
  let website = `https://${itchUsername}.itch.io`;
  let itchProfile = `https://itch.io/profile/${itchUsername}`;

  let r = db.replacer();
  let result = await db.queryAsync(
    /* SQL */ `
  SELECT "userId" FROM "user" WHERE "userId" = ${r(userId)};
  `,
    r.values()
  );
  if (result.rowCount) {
    console.log(`Itch user ${itchUsername} already exists; skipping.`);
    return;
  }
  gqAsync(
    /* GraphQL */ `
      mutation(
        $username: String!
        $userId: String!
        $name: String!
        $website: String
        $itchProfile: String
        $password: String!
      ) {
        signup(
          user: {
            userId: $userId
            username: $username
            name: $name
            links: { itch: $website, itchProfile: $itchProfile }
          }
          password: $password
        ) {
          userId
          name
          username
        }
      }
    `,
    {
      password: itchUsername + '123',
      username,
      userId,
      name,
      itchProfile,
      website,
    }
  );
}

module.exports = {
  addItchGameAsync,
  addItchUserAsync,
};
