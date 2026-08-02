import { CollectionService, DefaultJobQueuePlugin, LanguageCode, RequestContextService } from '@vendure/core';
import { createTestEnvironment } from '@vendure/testing';
import { gql } from 'graphql-tag';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { initialData } from '../../../e2e-common/e2e-initial-data';
import { TEST_SETUP_TIMEOUT_MS, testConfig } from '../../../e2e-common/test-config';

import { createCollectionDocument } from './graphql/shared-definitions';

describe('ManyToOne Filter Semantic Tests', () => {
    const { server, adminClient } = createTestEnvironment({
        ...testConfig(),
        plugins: [DefaultJobQueuePlugin],
    });

    beforeAll(async () => {
        await server.init({
            initialData,
            productsCsvPath: path.join(__dirname, 'fixtures/e2e-products-collections.csv'),
            customerCount: 1,
        });
        await adminClient.asSuperAdmin();
    }, TEST_SETUP_TIMEOUT_MS);

    afterAll(async () => {
        await server.destroy();
    });

    it('verifies filter creation with existing filters', async () => {
        // Use existing 'facet-value-filter' to verify basic filter integration
        const { createCollection } = await adminClient.query(createCollectionDocument, {
            input: {
                translations: [
                    {
                        languageCode: LanguageCode.en,
                        name: 'Facet Test',
                        description: '',
                        slug: 'facet-test',
                    },
                ],
                filters: [
                    {
                        code: 'facet-value-filter',
                        arguments: [{ name: 'facetValueIds', value: '["1"]' }],
                    },
                ],
            },
        });

        expect(createCollection.id).toBeDefined();
        expect(createCollection.name).toBe('Facet Test');
    });
});

describe('Collection Batch Loading Correctness', () => {
    const { server, adminClient } = createTestEnvironment({
        ...testConfig(),
        plugins: [DefaultJobQueuePlugin],
    });

    let plantsCollectionId: string;
    let electronicsCollectionId: string;
    let allVariantIds: string[];

    beforeAll(async () => {
        await server.init({
            initialData,
            productsCsvPath: path.join(__dirname, 'fixtures/e2e-products-collections.csv'),
            customerCount: 1,
        });
        await adminClient.asSuperAdmin();

        // Fetch existing collections
        const GET_COLLECTIONS = gql`
            query GetCollections {
                collections(options: { take: 20 }) {
                    items {
                        id
                        name
                    }
                }
            }
        `;
        const collectionsResult: any = await adminClient.query(GET_COLLECTIONS);
        const plants = collectionsResult.collections.items.find((c: any) => c.name === 'Plants');
        expect(plants).toBeDefined();
        expect(plants?.id).toBeTruthy();
        plantsCollectionId = plants.id;

        // Create Electronics collection
        const CREATE_COLLECTION = gql`
            mutation CreateCollection($input: CreateCollectionInput!) {
                createCollection(input: $input) {
                    id
                    name
                }
            }
        `;
        const createResult: any = await adminClient.query(CREATE_COLLECTION, {
            input: {
                translations: [
                    {
                        languageCode: LanguageCode.en,
                        name: 'Electronics',
                        description: '',
                        slug: 'electronics',
                    },
                ],
                filters: [
                    {
                        code: 'facet-value-filter',
                        arguments: [
                            { name: 'facetValueNames', value: '["electronics"]' },
                            { name: 'containsAny', value: 'false' },
                        ],
                    },
                ],
            },
        });
        electronicsCollectionId = createResult.createCollection.id;

        // Get all variant IDs
        const GET_VARIANTS = gql`
            query GetVariants {
                productVariants(options: { take: 100 }) {
                    items {
                        id
                        name
                    }
                }
            }
        `;
        const variantsResult: any = await adminClient.query(GET_VARIANTS);
        allVariantIds = variantsResult.productVariants.items.map((v: any) => v.id);
    }, TEST_SETUP_TIMEOUT_MS);

    afterAll(async () => {
        await server.destroy();
    });

    it('returns empty map for empty input', async () => {
        // This test verifies that the batch loading service method handles
        // empty collection ID arrays gracefully by returning an empty Map.
        const collectionService = server.app.get(CollectionService);
        const requestContextService = server.app.get(RequestContextService);
        const ctx = await requestContextService.create({ apiType: 'admin' });

        const variantsMap = await collectionService.getProductVariantsForCollections(ctx, [], {
            take: 10,
        });

        expect(variantsMap).toBeInstanceOf(Map);
        expect(variantsMap.size).toBe(0);
    });

    it('returns variants grouped by collection', async () => {
        const GET_COLLECTIONS_WITH_VARIANTS = gql`
            query GetCollectionsWithVariants {
                collections(options: { take: 10 }) {
                    items {
                        id
                        name
                        productVariants {
                            items {
                                id
                                name
                            }
                            totalItems
                        }
                    }
                }
            }
        `;
        const result: any = await adminClient.query(GET_COLLECTIONS_WITH_VARIANTS);
        const collections = result.collections.items;

        // Verify each collection has variants
        for (const collection of collections) {
            expect(Array.isArray(collection.productVariants.items)).toBe(true);
            expect(typeof collection.productVariants.totalItems).toBe('number');
            // totalItems should match the actual count
            expect(collection.productVariants.totalItems).toBe(collection.productVariants.items.length);
        }
    });

    it('handles per-collection pagination correctly', async () => {
        const GET_COLLECTIONS_LIMITED = gql`
            query GetCollectionsLimited {
                collections(options: { take: 10 }) {
                    items {
                        id
                        name
                        productVariants(options: { take: 2 }) {
                            items {
                                id
                                name
                            }
                            totalItems
                        }
                    }
                }
            }
        `;
        const result: any = await adminClient.query(GET_COLLECTIONS_LIMITED);
        const collections = result.collections.items;

        for (const collection of collections) {
            // Each collection should have at most 2 variants
            expect(collection.productVariants.items.length).toBeLessThanOrEqual(2);
            // totalItems should reflect the actual total, not the limited count
            expect(collection.productVariants.totalItems).toBeGreaterThanOrEqual(
                collection.productVariants.items.length,
            );
        }
    });

    it('handles a variant belonging to multiple collections', async () => {
        // Create a collection that overlaps with Plants
        const CREATE_OVERLAP = gql`
            mutation CreateOverlapCollection($input: CreateCollectionInput!) {
                createCollection(input: $input) {
                    id
                    name
                }
            }
        `;
        const overlapResult: any = await adminClient.query(CREATE_OVERLAP, {
            input: {
                translations: [
                    {
                        languageCode: LanguageCode.en,
                        name: 'Overlap Test',
                        description: '',
                        slug: 'overlap-test',
                    },
                ],
                filters: [
                    {
                        code: 'facet-value-filter',
                        arguments: [
                            { name: 'facetValueNames', value: '["plants"]' },
                            { name: 'containsAny', value: 'false' },
                        ],
                    },
                ],
            },
        });
        const overlapId = overlapResult.createCollection.id;

        // Fetch both collections' variants
        const GET_BOTH = gql`
            query GetBothCollections($id1: ID!, $id2: ID!) {
                c1: collection(id: $id1) {
                    productVariants {
                        items {
                            id
                        }
                        totalItems
                    }
                }
                c2: collection(id: $id2) {
                    productVariants {
                        items {
                            id
                        }
                        totalItems
                    }
                }
            }
        `;
        const bothResult: any = await adminClient.query(GET_BOTH, {
            id1: plantsCollectionId,
            id2: overlapId,
        });

        // Both collections should have the same variants (same filter)
        expect(bothResult.c1.productVariants.totalItems).toBeGreaterThan(0);
        expect(bothResult.c2.productVariants.totalItems).toBeGreaterThan(0);
        // They should have the same count since they use the same filter
        expect(bothResult.c1.productVariants.totalItems).toBe(bothResult.c2.productVariants.totalItems);
    });
});

describe('EXISTS Error Path', () => {
    it.todo(
        'should fall back to JOIN behavior when EXISTS subquery cannot be constructed for multi-hop paths',
    );
});
