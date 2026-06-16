import type { IExecuteFunctions } from 'n8n-workflow';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ImobiliareListings } from '../ImobiliareListings.node';

const read = (name: string) => readFileSync(join(__dirname, 'fixtures', name), 'utf8');
const SEARCH = read('search-cluj.html');
const DETAIL = read('detail-275453001.html');

/** Mock imobiliare: search page (page 1 only), empty for deeper pages, detail page. */
function httpMock(): jest.Mock {
    return jest.fn(async (opts: { url: string }) => {
        if (opts.url.includes('/oferta/')) return DETAIL;
        if (opts.url.includes('pagina=')) return '<html><body></body></html>';
        return SEARCH;
    });
}

type StaticData = Record<string, unknown>;

function makeContext(
    params: Record<string, unknown>,
    httpRequest: jest.Mock,
    staticData: StaticData = {},
): IExecuteFunctions {
    return {
        getInputData: () => [{ json: {} }],
        getNodeParameter: (name: string) => params[name],
        getWorkflowStaticData: () => staticData,
        getNode: () => ({ name: 'Imobiliare Listings' }),
        continueOnFail: () => false,
        helpers: { httpRequest },
    } as unknown as IExecuteFunctions;
}

async function run(params: Record<string, unknown>, staticData: StaticData = {}) {
    const httpRequest = httpMock();
    const result = await new ImobiliareListings().execute.call(
        makeContext(params, httpRequest, staticData),
    );
    return { items: result[0], httpRequest };
}

const searchParams = (over: Record<string, unknown> = {}) => ({
    operation: 'search',
    searchUrl: 'https://www.imobiliare.ro/vanzare-apartamente/cluj-napoca',
    maxResults: 50,
    onlyNew: false,
    ...over,
});

describe('ImobiliareListings.execute — search', () => {
    it('returns one item per listing card', async () => {
        const { items } = await run(searchParams());
        expect(items.length).toBe(12);
        expect(items[0].json).toMatchObject({ id: '272873020', price: 320000, rooms: 2 });
    });

    it('honors maxResults', async () => {
        const { items } = await run(searchParams({ maxResults: 3 }));
        expect(items).toHaveLength(3);
    });

    it('with onlyNew, returns nothing on the second run', async () => {
        const staticData: StaticData = {};
        const first = await run(searchParams({ onlyNew: true }), staticData);
        expect(first.items.length).toBe(12);
        const second = await run(searchParams({ onlyNew: true }), staticData);
        expect(second.items).toHaveLength(0);
    });

    it('rejects a non-imobiliare URL', async () => {
        await expect(run(searchParams({ searchUrl: 'https://example.com/x' }))).rejects.toThrow(
            /imobiliare\.ro URL/,
        );
    });
});

describe('ImobiliareListings.execute — getDetails', () => {
    it('returns a mapped listing detail', async () => {
        const { items } = await run({
            operation: 'getDetails',
            listingUrl:
                'https://www.imobiliare.ro/oferta/apartament-de-vanzare-cluj-napoca-marasti-mobilat-2-camere-275453001',
        });
        expect(items[0].json).toMatchObject({
            id: '275453001',
            price: 159000,
            currency: 'EUR',
            agentName: 'SMART IMOBILIARE',
        });
    });

    it('rejects a non-listing URL', async () => {
        await expect(
            run({ operation: 'getDetails', listingUrl: 'https://www.imobiliare.ro/vanzare-apartamente/cluj' }),
        ).rejects.toThrow(/oferta/);
    });
});
