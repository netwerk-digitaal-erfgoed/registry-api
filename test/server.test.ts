import nock from 'nock';
import {FastifyInstance} from 'fastify';
import {Server} from 'http';
import {server} from '../src/server';
import {readUrl, ShaclValidator} from '../src/validator';
import {
  MockAllowedRegistrationDomainStore,
  MockDatasetStore,
  MockRegistrationStore,
} from './mock';

let httpServer: FastifyInstance<Server>;
describe('Server', () => {
  beforeAll(async () => {
    const shacl = await readUrl('shacl/register.ttl');
    httpServer = await server(
      new MockDatasetStore(),
      new MockRegistrationStore(),
      new MockAllowedRegistrationDomainStore(),
      new ShaclValidator(shacl),
      shacl
    );

    nock.back.fixtures = __dirname + '/http';
    nock.back.setMode('record');
  });

  afterAll(() => {
    nock.restore();
  });

  it('rejects validation requests without URL', async () => {
    const response = await httpServer.inject({
      method: 'PUT',
      url: '/datasets/validate',
    });
    expect(response.statusCode).toEqual(400);
  });

  it('rejects validation requests that point to 404 URL', async () => {
    nock('https://example.com/').get('/404').reply(404);
    const response = await httpServer.inject({
      method: 'PUT',
      url: '/datasets/validate',
      headers: {'Content-Type': 'application/ld+json'},
      payload: JSON.stringify({
        '@id': 'https://example.com/404',
      }),
    });
    expect(response.statusCode).toEqual(404);
  });

  it('responds with 200 to valid dataset requests', async () => {
    const {nockDone} = await nock.back('valid-dataset.json');
    const response = await httpServer.inject({
      method: 'PUT',
      url: '/datasets/validate',
      headers: {'Content-Type': 'application/ld+json'},
      payload: JSON.stringify({
        '@id': 'https://demo.netwerkdigitaalerfgoed.nl/datasets/kb/2.html',
      }),
    });
    nockDone();
    expect(response.statusCode).toEqual(200);
  });

  it('responds with validation errors to invalid dataset requests', async () => {
    const {nockDone} = await nock.back('invalid-dataset.json');
    const response = await httpServer.inject({
      method: 'PUT',
      url: '/datasets/validate',
      headers: {'Content-Type': 'application/ld+json'},
      payload: JSON.stringify({
        '@id': 'https://demo.netwerkdigitaalerfgoed.nl/datasets/kb/2a.html',
      }),
    });
    nockDone();
    expect(response.statusCode).toEqual(400);
    expect(response.headers['content-type']).toEqual('application/ld+json');
  });

  it('handles UTF-8 BOMs', async () => {
    const {nockDone} = await nock.back('utf8-bom.json');
    const response = await httpServer.inject({
      method: 'PUT',
      url: '/datasets/validate',
      headers: {'Content-Type': 'application/ld+json'},
      payload: JSON.stringify({
        '@id':
          'https://littest.hosting.deventit.net/Atlantispubliek/data/set/catalog.ttl',
      }),
    });
    nockDone();
    expect(response.statusCode).toEqual(406);
  });

  it('rejects unauthorized domains', async () => {
    const response = await httpServer.inject({
      method: 'POST',
      url: '/datasets',
      headers: {'Content-Type': 'application/ld+json'},
      payload: JSON.stringify({
        '@id': 'https://subdomain.not-allowed.com/dataset',
      }),
    });
    expect(response.statusCode).toEqual(403);
  });

  it('accepts authorized domains', async () => {
    const {nockDone} = await nock.back('post-dataset.json');
    const response = await httpServer.inject({
      method: 'POST',
      url: '/datasets',
      headers: {'Content-Type': 'application/ld+json'},
      payload: JSON.stringify({
        '@id': 'https://demo.netwerkdigitaalerfgoed.nl/datasets/kb/2.html',
      }),
    });
    nockDone();
    expect(response.statusCode).toEqual(202);
  });

  it('returns SHACL graph', async () => {
    const response = await httpServer.inject({
      method: 'GET',
      url: '/shacl',
      headers: {'Content-Type': 'text/turtle'},
    });
    expect(response.statusCode).toEqual(200);
  });
});
