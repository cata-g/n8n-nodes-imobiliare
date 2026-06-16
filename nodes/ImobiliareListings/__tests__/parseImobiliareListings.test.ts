import { readFileSync } from 'fs';
import { join } from 'path';
import {
    decodeEntities,
    parseRoNumber,
    parseSearchListings,
    parseListingDetail,
} from '../ImobiliareListings.node';

const html = (name: string) => readFileSync(join(__dirname, 'fixtures', name), 'utf8');

describe('decodeEntities', () => {
    it('decodes numeric and named HTML entities', () => {
        expect(decodeEntities('M&#259;r&#259;&#537;ti')).toBe('Mărăști');
        expect(decodeEntities('v&acirc;nzare &amp; &icirc;nchiriere')).toBe('vânzare & închiriere');
    });
    it('returns null for non-strings', () => {
        expect(decodeEntities(undefined)).toBeNull();
        expect(decodeEntities(42)).toBeNull();
    });
});

describe('parseRoNumber', () => {
    it('parses Romanian number formatting', () => {
        expect(parseRoNumber('159.000')).toBe(159000);
        expect(parseRoNumber('56,5')).toBe(56.5);
        expect(parseRoNumber('')).toBeNull();
    });
});

describe('parseSearchListings — real imobiliare cards', () => {
    const listings = parseSearchListings(html('search-cluj.html'));

    it('parses every card with the core fields', () => {
        expect(listings.length).toBe(12);
        const first = listings[0];
        expect(first.id).toBe('272873020');
        expect(first.price).toBe(320000);
        expect(first.currency).toBe('EUR');
        expect(first.rooms).toBe(2);
        expect(first.surface).toBe(61);
        expect(first.title).toContain('Apartament lux');
        expect(first.location).toBe('Semicentral, Cluj-Napoca');
        expect(first.url).toMatch(/^https:\/\/www\.imobiliare\.ro\/oferta\//);
    });

    it('flags a price drop when the card shows an old price', () => {
        const dropped = listings.find((l) => l.id === '275353060');
        expect(dropped).toBeDefined();
        expect(dropped!.priceDropped).toBe(true);
        expect(dropped!.price).toBe(199000);
        expect(dropped!.oldPrice).toBe(203000);
    });

    it('returns no duplicate listing ids', () => {
        const ids = listings.map((l) => l.id);
        expect(new Set(ids).size).toBe(ids.length);
    });
});

describe('parseListingDetail — real listing JSON-LD', () => {
    const d = parseListingDetail(html('detail-275453001.html'));

    it('maps price, rooms and surface from schema.org data', () => {
        expect(d.id).toBe('275453001');
        expect(d.price).toBe(159000);
        expect(d.currency).toBe('EUR');
        expect(d.rooms).toBe(2);
        expect(d.surface).toBe(44);
        expect(d.bathrooms).toBe(1);
    });

    it('maps decoded address and agent details', () => {
        expect(d.locality).toBe('Mărăști');
        expect(d.region).toBe('Cluj-Napoca');
        expect(d.agentName).toBe('SMART IMOBILIARE');
        expect(d.title).toContain('Apartament');
    });
});
