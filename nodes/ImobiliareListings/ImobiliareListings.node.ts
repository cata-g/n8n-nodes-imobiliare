import {
    IExecuteFunctions,
    INodeExecutionData,
    INodeType,
    INodeTypeDescription,
    IDataObject,
    NodeOperationError,
} from 'n8n-workflow';
import * as cheerio from 'cheerio';

const BASE = 'https://www.imobiliare.ro';
const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': USER_AGENT, 'Accept-Language': 'ro-RO,ro;q=0.9' };

/** Decode the HTML entities imobiliare leaves inside its JSON-LD strings. */
export function decodeEntities(input: unknown): string | null {
    if (typeof input !== 'string') return null;
    return input
        .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&(?:#39|apos);/g, "'")
        .replace(/&acirc;/g, 'â')
        .replace(/&Acirc;/g, 'Â')
        .replace(/&icirc;/g, 'î')
        .replace(/&Icirc;/g, 'Î')
        .replace(/\r\n/g, '\n')
        .trim();
}

/** Parse a Romanian-formatted number ("159.000" -> 159000, "56,5" -> 56.5). */
export function parseRoNumber(value: string | null | undefined): number | null {
    if (value == null) return null;
    const t = String(value).trim();
    if (t === '') return null;
    const n = parseFloat(t.replace(/\./g, '').replace(',', '.'));
    return Number.isNaN(n) ? null : n;
}

/**
 * Parse an imobiliare.ro search-results page into a list of listings.
 * Pure function (no network) so it can be unit-tested against saved HTML.
 * Reads each server-rendered listing card; `priceDropped` is true when the card
 * shows an old price ("Preț vechi").
 */
export function parseSearchListings(html: string): IDataObject[] {
    const $ = cheerio.load(html);
    const out: IDataObject[] = [];
    const seen = new Set<string>();

    $('a[href*="/oferta/"]').each((_, a) => {
        const href = $(a).attr('href') || '';
        const idMatch = href.match(/(\d{6,})/);
        if (!idMatch) return;
        const id = idMatch[1];
        if (seen.has(id)) return;

        // Walk up to the card container (the smallest ancestor with a price + surface).
        let card = $(a);
        let text = '';
        for (let k = 0; k < 9; k++) {
            card = card.parent();
            if (!card.get(0)) return;
            text = card.text().replace(/\s+/g, ' ').trim();
            if (/€|EUR|lei/.test(text) && /\bmp\b|m²/.test(text) && text.length < 1200) break;
            if (k === 8) return;
        }
        seen.add(id);

        const prices = [...text.matchAll(/([\d][\d.]*)\s*(?:€|EUR|lei)/g)].map((m) =>
            parseRoNumber(m[1]),
        );
        const price = prices[0] ?? null;
        const priceDropped = /Pre[țt] vechi/i.test(text) && prices.length >= 2;
        const oldPrice = priceDropped ? prices[1] : null;
        const currency = /lei/i.test(text) ? 'RON' : 'EUR';

        const rooms = text.match(/(\d+)\s*camere/);
        const surface = text.match(/(\d+(?:[.,]\d+)?)\s*(?:mp|m²)/);
        const floor = text.match(/Etaj\s*([\d]+\s*\/\s*\d+|parter|demisol|mansard[ăa])/i);
        // "Area, City" immediately before "N camere" (bounded so it can't span the title).
        const loc = text.match(
            /([A-ZĂÂÎȘȚ][A-Za-zĂÂÎȘȚăâîșț-]+(?:\s[A-ZĂÂÎȘȚ][A-Za-zĂÂÎȘȚăâîșț-]+){0,2}),\s*([A-ZĂÂÎȘȚ][A-Za-zĂÂÎȘȚăâîșț-]+(?:\s[A-Za-zĂÂÎȘȚăâîșț-]+){0,2})\s+\d+\s*camere/,
        );
        const title = text.split(/\s*[\d][\d.]*\s*(?:€|EUR|lei)/)[0].trim() || null;

        out.push({
            id,
            url: href.startsWith('http') ? href : BASE + href,
            title,
            price,
            currency,
            oldPrice,
            priceDropped: !!priceDropped && oldPrice !== null && (oldPrice as number) > (price as number),
            rooms: rooms ? parseInt(rooms[1], 10) : null,
            surface: surface ? parseRoNumber(surface[1]) : null,
            floor: floor ? floor[1].replace(/\s+/g, ' ').trim() : null,
            location: loc ? `${loc[1].trim()}, ${loc[2].trim()}` : null,
        });
    });

    return out;
}

/** Find the first @graph node of a given @type. */
function nodeOfType(graph: IDataObject[], type: string): IDataObject | undefined {
    return graph.find((n) => {
        const t = n['@type'];
        return Array.isArray(t) ? (t as unknown[]).includes(type) : t === type;
    });
}

/**
 * Parse an imobiliare.ro listing detail page from its schema.org JSON-LD.
 * Pure function so it can be unit-tested against saved HTML.
 */
export function parseListingDetail(html: string): IDataObject {
    const $ = cheerio.load(html);
    const raw = $('script[type="application/ld+json"]').first().contents().text() ||
        $('script[type="application/ld+json"]').first().text();

    let graph: IDataObject[] = [];
    try {
        const parsed = JSON.parse(raw) as IDataObject;
        graph = (parsed['@graph'] as IDataObject[]) ?? [parsed];
    } catch {
        graph = [];
    }

    const product = nodeOfType(graph, 'Product');
    const offer = nodeOfType(graph, 'Offer');
    const acc = nodeOfType(graph, 'Accommodation');
    const addr = nodeOfType(graph, 'PostalAddress');
    const agent = nodeOfType(graph, 'RealEstateAgent');
    const person = nodeOfType(graph, 'Person');

    const priceSpec = (offer?.priceSpecification ?? {}) as IDataObject;
    const offerUrl = (offer?.url as string) ?? null;
    const id = offerUrl ? (offerUrl.match(/(\d{6,})/) || [])[1] ?? null : null;

    return {
        id,
        url: offerUrl,
        title: decodeEntities(product?.name),
        description: decodeEntities(product?.description),
        price: (priceSpec.price as number) ?? null,
        currency: (priceSpec.priceCurrency as string) ?? null,
        rooms: (acc?.numberOfBedrooms as number) ?? null,
        bathrooms: (acc?.numberOfBathroomsTotal as number) ?? null,
        surface: (acc?.floorSize as number) ?? null,
        floor: (acc?.floorLevel as string) ?? null,
        street: decodeEntities(addr?.streetAddress),
        locality: decodeEntities(addr?.addressLocality),
        region: decodeEntities(addr?.addressRegion),
        country: (addr?.addressCountry as string) ?? null,
        agentName: decodeEntities(agent?.name),
        agentUrl: (agent?.url as string) ?? null,
        agentLegalName: decodeEntities(agent?.legalName),
        contactName: decodeEntities(person?.givenName),
        contactRole: decodeEntities(person?.jobTitle),
    };
}

export class ImobiliareListings implements INodeType {
    description: INodeTypeDescription = {
        displayName: 'Imobiliare Listings',
        name: 'imobiliareListings',
        icon: 'file:imobiliare.svg',
        group: ['transform'],
        version: 1,
        subtitle: '={{$parameter["operation"]}}',
        description: 'Search and monitor imobiliare.ro property listings',
        defaults: {
            name: 'Imobiliare Listings',
        },
        inputs: ['main'],
        outputs: ['main'],
        properties: [
            {
                displayName: 'Operation',
                name: 'operation',
                type: 'options',
                noDataExpression: true,
                options: [
                    {
                        name: 'Get Listing Details',
                        value: 'getDetails',
                        action: 'Get full details for one listing',
                        description: 'Fetch a single listing page and parse its structured data',
                    },
                    {
                        name: 'Search Listings',
                        value: 'search',
                        action: 'Search listings from a search URL',
                        description: 'Parse listing cards from an imobiliare.ro search URL',
                    },
                ],
                default: 'search',
            },
            {
                displayName: 'Search URL',
                name: 'searchUrl',
                type: 'string',
                default: '',
                placeholder: 'https://www.imobiliare.ro/vanzare-apartamente/cluj-napoca?...',
                description:
                    'An imobiliare.ro search URL. Apply your filters (location, rooms, price) on the site, then paste the URL here.',
                required: true,
                displayOptions: {
                    show: {
                        operation: ['search'],
                    },
                },
            },
            {
                displayName: 'Max Results',
                name: 'maxResults',
                type: 'number',
                typeOptions: {
                    minValue: 1,
                },
                default: 50,
                description: 'Max number of listings to return',
                displayOptions: {
                    show: {
                        operation: ['search'],
                    },
                },
            },
            {
                displayName: 'Only New Since Last Run',
                name: 'onlyNew',
                type: 'boolean',
                default: false,
                description:
                    'Whether to return only listings not seen on previous runs of this node, for monitoring on a schedule',
                displayOptions: {
                    show: {
                        operation: ['search'],
                    },
                },
            },
            {
                displayName: 'Listing URL',
                name: 'listingUrl',
                type: 'string',
                default: '',
                placeholder: 'https://www.imobiliare.ro/oferta/...',
                description: 'The full URL of the listing to fetch',
                required: true,
                displayOptions: {
                    show: {
                        operation: ['getDetails'],
                    },
                },
            },
        ],
    };

    async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
        const items = this.getInputData();
        const returnData: INodeExecutionData[] = [];

        const fetchHtml = (url: string): Promise<string> =>
            this.helpers.httpRequest({
                method: 'GET',
                url,
                headers: HEADERS,
                timeout: 20000,
            }) as Promise<string>;

        for (let i = 0; i < items.length; i++) {
            try {
                const operation = this.getNodeParameter('operation', i) as string;

                if (operation === 'getDetails') {
                    const listingUrl = (this.getNodeParameter('listingUrl', i) as string).trim();
                    if (!/^https?:\/\/.*imobiliare\.ro\/oferta\//.test(listingUrl)) {
                        throw new NodeOperationError(
                            this.getNode(),
                            'Listing URL must be an imobiliare.ro /oferta/ link',
                            { itemIndex: i },
                        );
                    }
                    const detail = parseListingDetail(await fetchHtml(listingUrl));
                    returnData.push({ json: detail, pairedItem: i });
                    continue;
                }

                // operation === 'search'
                const searchUrl = (this.getNodeParameter('searchUrl', i) as string).trim();
                if (!/^https?:\/\/.*imobiliare\.ro\//.test(searchUrl)) {
                    throw new NodeOperationError(
                        this.getNode(),
                        'Search URL must be an imobiliare.ro URL',
                        { itemIndex: i },
                    );
                }
                const maxResults = this.getNodeParameter('maxResults', i) as number;
                const onlyNew = this.getNodeParameter('onlyNew', i) as boolean;

                const seenData = onlyNew ? this.getWorkflowStaticData('node') : null;
                const seenIds = new Set((seenData?.seenListingIds as string[]) ?? []);

                const collected: IDataObject[] = [];
                const maxPages = 10;
                for (let page = 1; page <= maxPages && collected.length < maxResults; page++) {
                    const url = new URL(searchUrl);
                    if (page > 1) url.searchParams.set('pagina', String(page));
                    const listings = parseSearchListings(await fetchHtml(url.toString()));
                    if (listings.length === 0) break;

                    for (const listing of listings) {
                        const id = listing.id as string;
                        if (onlyNew && seenIds.has(id)) continue;
                        if (onlyNew) seenIds.add(id);
                        collected.push(listing);
                        if (collected.length >= maxResults) break;
                    }
                    if (listings.length < 10) break; // likely the last page
                }

                if (onlyNew && seenData) {
                    seenData.seenListingIds = [...seenIds].slice(-5000);
                }

                for (const listing of collected) {
                    returnData.push({ json: listing, pairedItem: i });
                }
            } catch (error) {
                if (this.continueOnFail()) {
                    returnData.push({ json: { error: (error as Error).message }, pairedItem: i });
                    continue;
                }
                throw error;
            }
        }

        return [returnData];
    }
}
