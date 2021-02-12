import fastify, {FastifyReply} from 'fastify';
import {ShaclValidator, Validator} from './validator';
import {StreamWriter} from 'n3';
import {toStream} from 'rdf-dataset-ext';
import {dereference, fetch, NoDatasetFoundAtUrl, UrlNotFound} from './fetch';
import DatasetExt from 'rdf-ext/lib/Dataset';
import {URL} from 'url';
import {
  GraphDbClient,
  GraphDbDatasetStore,
  GraphDbRegistrationStore,
} from './graphdb';
import {Registration} from './registration';
import {extractIris} from './dataset';
import {scheduleJob} from 'node-schedule';
import {Crawler} from './crawler';

const server = fastify({logger: process.env.LOG ? !!+process.env.LOG : true});
const client = new GraphDbClient(
  process.env.GRAPHDB_URL || 'http://localhost:7200',
  'registry'
);
const datasetStore = new GraphDbDatasetStore(client);
const registrationStore = new GraphDbRegistrationStore(client);
let validator: Validator;

const datasetsRequest = {
  schema: {
    body: {
      type: 'object',
      required: ['@id'],
      properties: {
        '@id': {type: 'string'},
      },
    },
  },
};

async function validate(
  url: URL,
  reply: FastifyReply
): Promise<DatasetExt | null> {
  let dataset: DatasetExt;
  try {
    dataset = await dereference(url);
  } catch (e) {
    if (e instanceof UrlNotFound) {
      reply.code(404).send('URL not found: ' + url);
    }
    if (e instanceof NoDatasetFoundAtUrl) {
      reply.code(406).send(e.message);
    }
    return null;
  }

  const validation = await validator.validate(dataset);
  switch (validation.state) {
    case 'valid':
      return dataset;
    case 'no-dataset':
      reply.code(406).send();
      return null;
    case 'invalid': {
      const streamWriter = new StreamWriter();
      const validationRdf = streamWriter.import(toStream(validation.errors));
      reply.code(400).send(validationRdf);
      return null;
    }
  }
}

server.post('/datasets', datasetsRequest, async (request, reply) => {
  const url = new URL((request.body as {'@id': string})['@id']);
  request.log.info(url.toString());
  if (await validate(url, reply)) {
    const datasets = await fetch(url);
    reply.code(202).send();
    await datasetStore.store(datasets);
    const registration = new Registration(url, new Date(), [
      ...extractIris(datasets).keys(),
    ]);
    registration.read();
    await registrationStore.store(registration);
  }
});

server.put('/datasets/validate', datasetsRequest, async (request, reply) => {
  const url = new URL((request.body as {'@id': string})['@id']);
  request.log.info(url.toString());
  if ((await validate(url, reply)) !== null) {
    reply.code(200).send();
  }
});

/**
 * Make Fastify accept JSON-LD payloads.
 */
server.addContentTypeParser(
  'application/ld+json',
  {parseAs: 'string'},
  (req, body: string, done) => {
    try {
      done(null, JSON.parse(body));
    } catch (err) {
      err.statusCode = 400;
      done(err, undefined);
    }
  }
);

(async () => {
  try {
    if (process.env.GRAPHDB_USERNAME && process.env.GRAPHDB_PASSWORD) {
      await client.authenticate(
        process.env.GRAPHDB_USERNAME,
        process.env.GRAPHDB_PASSWORD
      );
    }
    validator = await ShaclValidator.fromUrl('shacl/dataset.jsonld');
    const crawler = new Crawler(registrationStore, datasetStore);

    // Start web server.
    await server.listen(3000, '0.0.0.0');

    // Schedule crawler to check every hour for CRAWLER_INTERVAL that have expired their REGISTRATION_URL_TTL.
    const ttl = ((process.env.REGISTRATION_URL_TTL || 86400) as number) * 1000;
    if (process.env.CRAWLER_SCHEDULE !== undefined) {
      scheduleJob(process.env.CRAWLER_SCHEDULE, () => {
        crawler.crawl(new Date(Date.now() - ttl));
      });
    }
  } catch (err) {
    console.error(err);
  }
})();
