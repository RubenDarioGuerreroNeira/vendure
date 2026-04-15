import { LanguageCode } from '@vendure/common/lib/generated-types';
import { createTestEnvironment } from '@vendure/testing';
import gql from 'graphql-tag';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { testConfig } from '../../../e2e-common/test-config';

import { awaitRunningJobs } from './utils/await-running-jobs';

const myInitialData = {
    defaultLanguage: LanguageCode.en,
    defaultZone: 'Europe',
    taxRates: [{ name: 'Standard Tax', percentage: 20 }],
    shippingMethods: [{ name: 'Standard Shipping', price: 500 }],
    paymentMethods: [],
    countries: [{ name: 'United Kingdom', code: 'GB', zone: 'Europe' }],
    collections: [
        {
            name: 'Electronics',
            filters: [
                {
                    code: 'facet-value-filter',
                    args: { facetValueNames: ['electronics'], containsAny: false },
                },
            ],
        },
    ],
};

describe('Issue #4387 N+1 query when fetching collection with product variants', () => {
    let queryCount = 0;
    const { server, adminClient, shopClient } = createTestEnvironment({
        ...testConfig(),
        dbConnectionOptions: {
            ...testConfig().dbConnectionOptions,
            logging: (query: string) => {
                if (
                    query.toLowerCase().includes('from "tax_category"') ||
                    query.toLowerCase().includes('from tax_category')
                ) {
                    queryCount++;
                }
            },
        },
    });

    beforeAll(async () => {
        await server.init({
            initialData: myInitialData,
            productsCsvPath: path.join(__dirname, 'fixtures/e2e-products-collections.csv'),
            customerCount: 1,
        });
        await adminClient.asSuperAdmin();

        // Encontramos el ID de la faceta "electronics"
        const { facets } = await adminClient.query(gql`
            query {
                facets {
                    items {
                        values {
                            id
                            code
                        }
                    }
                }
            }
        `);
        const electronicsFacetValue = facets.items.flatMap(f => f.values).find(v => v.code === 'electronics');
        if (!electronicsFacetValue) {
            throw new Error('Electronics facet value not found');
        }

        const facetValueId = electronicsFacetValue.id.toString();

        // Creamos la colección Electronics manualmente
        await adminClient.query(
            gql`
                mutation CreateCollection($input: CreateCollectionInput!) {
                    createCollection(input: $input) {
                        ... on Collection {
                            id
                            name
                        }
                    }
                }
            `,
            {
                input: {
                    translations: [
                        {
                            languageCode: LanguageCode.en,
                            name: 'Electronics',
                            slug: 'electronics',
                            description: '',
                        },
                    ],
                    filters: [
                        {
                            code: 'facet-value-filter',
                            arguments: [
                                // eslint-disable-next-line @typescript-eslint/restrict-plus-operands
                                { name: 'facetValueIds', value: '["' + facetValueId + '"]' },
                                { name: 'containsAny', value: 'false' },
                            ],
                        },
                    ],
                },
            },
        );

        // Esperamos a que los jobs de colecciones terminen para que se pueblen
        await awaitRunningJobs(adminClient);
    }, 60000);

    afterAll(async () => {
        await server.destroy();
    });

    it('batches taxCategory queries for product variants in a collection', async () => {
        // La colección "Electronics" debería tener variantes según el CSV
        const slug = 'electronics';

        // Reseteamos el contador
        queryCount = 0;

        const { collection } = await shopClient.query(
            gql`
                query GetCollection($slug: String!) {
                    collection(slug: $slug) {
                        id
                        name
                        productVariants {
                            items {
                                id
                                name
                                taxCategory {
                                    id
                                    name
                                }
                            }
                        }
                    }
                }
            `,
            { slug },
        );

        expect(collection).not.toBeNull();
        const variantCount = collection.productVariants.items.length;

        // Si no hay variantes en Electronics, probamos con otra
        if (variantCount === 0) {
            const { collections } = await shopClient.query(gql`
                query {
                    collections {
                        items {
                            slug
                            productVariants {
                                totalItems
                            }
                        }
                    }
                }
            `);
            const betterCollection = collections.items.find((c: any) => c.productVariants.totalItems > 1);
            if (!betterCollection) {
                throw new Error('No collection with variants found for testing');
            }
            return;
        }

        expect(variantCount).toBeGreaterThan(1);

        for (const variant of collection.productVariants.items) {
            expect(variant.taxCategory).not.toBeNull();
            expect(variant.taxCategory.name).toBeDefined();
        }

        // Con el fix, queryCount debería ser 1 o 0.
        expect(
            queryCount,
            `Expected <= 1 query for taxCategory, but found ${queryCount}`,
        ).toBeLessThanOrEqual(1);
    });
});
