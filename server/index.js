let time = require('@expo/time');
let _tkLoaded = time.start();
let _tkPrimedAndStarted = time.start();

let bodyParser = require('body-parser');
let cors = require('cors');
let escapeHtml = require('escape-html');
let graphqlYoga = require('graphql-yoga');
let spawnAsync = require('@expo/spawn-async');

let db = require('./db');
let loaders = require('./loaders');
let model = require('./model');
let resolvers = require('./resolvers');
let typeDefs = require('./typeDefs');

let makeGraphqlContextAsync = async ({ request }) => {
  let clientId = request.get('X-ClientId');
  let userId = null;
  if (clientId) {
    userId = await model.getUserIdForSessionAsync(clientId);
  }
  return {
    request,
    loaders: loaders.createLoaders(),
    clientId,
    userId,
  };
};

async function serveAsync(port) {
  let endpoints = {
    status: '/status',
    graphql: '/graphql',
    playground: '/graphql',
    subscriptions: '/subscriptions',
  };

  let graphqlTimingMiddleware = async (resolve, parent, args, context, info) => {
    if (!parent) {
      let message = info.path.key + ' ' + JSON.stringify(args) + ' ' + JSON.stringify(info.variableValues);
      context.request.__logMessage = message;
      let tk = time.start();
      let result;
      try {
        result = await Promise.resolve(resolve());
      } catch (e) {
        // A dev/prod difference. In general, I think these are very bad
        // but here, the risk/reward tradeoff is probably worth it since we
        // don't want to expose stack traces, etc. to end users, but we do
        // want to see errors if they happen while we're developing stuff
        if (process.env.NODE_ENV === 'production') {
          if (e.type === 'CLIENT_ERROR') {
            throw e;
          } else {
            throw new Error('Internal Server Error');
          }
        } else {
          throw e;
        }
      } finally {
        time.end(tk, 'graphql', { message });
      }
      return result;
    } else {
      return resolve();
    }
  };

  let requestTimingMiddleware = (req, res, next) => {
    let tk = time.start();
    res.once('finish', () => {
      time.end(tk, 'request', { message: req.url + ' ' + req.__logMessage });
    });
    next();
  };

  let app = new graphqlYoga.GraphQLServer({
    typeDefs,
    resolvers,
    context: makeGraphqlContextAsync,
    middlewares: [graphqlTimingMiddleware],
  });
  app.use(requestTimingMiddleware);
  app.use(cors());
  app.use(bodyParser.json());
  app.get(endpoints.status, async (req, res) => {
    res.json({ status: 'OK' });
  });

  // Homepage with some info
  app.get('/', async (req, res) => {
    let pkg = require('./package');
    let gitResult = await spawnAsync('git', ['log', '--pretty=oneline', '-n1']);
    let links = [];
    for (let name in endpoints) {
      links.push(
        '    ' +
          name +
          '  ' +
          '<a href=' +
          JSON.stringify(endpoints[name]) +
          '>' +
          endpoints[name] +
          '</a>'
      );
    }

    let title = '👻 ' + pkg.name + ' v' + pkg.version;
    res.send(
      '<title>' +
        title +
        '</title>' +
        '<pre>' +
        title +
        '<br /><br /><a href="' +
        pkg.repository +
        '">' +
        escapeHtml(gitResult.stdout) +
        '</a><br />' +
        links.join('\n') +
        '</pre>'
    );
  });

  // Report the time it takes to load all the code separate
  // from the time it takes to connect to the database
  time.end(_tkLoaded, 'loaded');

  // Make a connection to the database so its ready to go
  await db.queryAsync('SELECT 1 AS primed');

  // Start the server
  port = port || process.env.PORT || 1380;
  app.start(
    {
      port,
      endpoint: endpoints.graphql,
      subscriptions: endpoints.subscriptions,
      playground: endpoints.playground,
    },
    (info) => {
      time.end(_tkPrimedAndStarted, 'server-start');
      console.log('Ghost server listening on port ' + info.port);
      console.log('http://localhost:' + port + '/');
    }
  );

  return app;
}

module.exports = serveAsync;

if (require.main === module) {
  serveAsync();
}
