/* eslint-disable no-console */
import { ID, FacetValue, VendureConfig } from '@vendure/core'; 
import { createTestEnvironment } from '@vendure/testing';  
import { gql } from 'graphql-tag';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { initialData } from '../e2e-initial-data';
import { testConfig } from '../test-config';

describe('ListQueryBuilder Optimization Benchmark', () => {
    let capturedQueries: string[] = [];
    const baseConfig = testConfig();

    const benchmarkConfig: VendureConfig = {
        ...baseConfig,
        customFields: {
            Product: [
                {
                    name: 'testManyToMany',
                    type: 'relation',
                    entity: FacetValue,
                    graphQLType: 'FacetValue',
                    list: true,
                },
                {
                    name: 'testManyToOne',
                    type: 'relation',
                    entity: FacetValue,
                    graphQLType: 'FacetValue',
                    list: false,
                },
            ],
        },
        dbConnectionOptions: {
            ...baseConfig.dbConnectionOptions,
            logging: ['query'],
            logger: {
                logQuery(query: string) {
                    if (
                        query.includes('SELECT') &&
                        (query.includes('"product"') || query.includes('`product`'))
                    ) {
                        capturedQueries.push(query);
                    }
                },
                logQueryError: (error: string) => console.error(error),
                logQuerySlow: (time: number, query: string) => console.warn(query, time),
                logSchemaBuild: () => {
                    /* no-op */
                },
                logMigration: () => {
                    /* no-op */
                },
                log: () => {
                    /* no-op */
                },
            } as any,
        },
    };

    const { server, adminClient } = createTestEnvironment(benchmarkConfig);

    beforeAll(async () => {
        await server.init({
            initialData,
            productsCsvPath: path.join(__dirname, '../../packages/core/e2e/fixtures/e2e-products-minimal.csv'), 
            customerCount: 1,
        });
        await adminClient.asSuperAdmin();
    }, 240000);

    afterAll(async () => {
        await server.destroy();
    });

    it('uses multiple EXISTS for ManyToMany custom field relation AND filter', async () => {
        const GET_PRODUCTS = gql`
            query GetProducts($options: ProductListOptions) {
                products(options: $options) {
                    items {
                        id
                    }
                    totalItems
                }
            }
        `;

        capturedQueries = [];

        await adminClient.query(GET_PRODUCTS, {
            options: {
                filter: {
                    _and: [
                        { testManyToManyId: { eq: '1' } },
                        { testManyToManyId: { eq: '2' } }
                    ],
                },
            },
        });

        const lastQuery = capturedQueries.find(q => q.includes('WHERE') && q.includes('testManyToMany'));
        expect(lastQuery, 'Should have a query with WHERE and testManyToMany').toBeDefined();
        if (lastQuery) {
            const existsCount = (lastQuery.match(/EXISTS/g) || []).length;
            expect(existsCount).toBe(2);
            // Verify no JOIN was added for the filter
            expect(lastQuery).not.toContain('LEFT JOIN');
        }
    });

    it('uses EXISTS for ManyToOne custom field relation when filtering (optimized)', async () => {
        const GET_PRODUCTS = gql`
            query GetProducts($options: ProductListOptions) {
                products(options: $options) {
                    items {
                        id
                    }
                    totalItems
                }
            }
        `;

        capturedQueries = [];

        await adminClient.query(GET_PRODUCTS, {
            options: {
                filter: {
                    testManyToOneId: { eq: '1' },
                },
            },
        });

        const lastQuery = capturedQueries.find(q => q.includes('WHERE') && q.includes('testManyToOne'));
        expect(lastQuery, 'Should have a query with WHERE and testManyToOne').toBeDefined();
        if (lastQuery) {
            const existsCount = (lastQuery.match(/EXISTS/g) || []).length;
            expect(existsCount).toBe(1);
            // Verify no JOIN was added for the ManyToOne filter (optimization)
            expect(lastQuery).not.toContain('LEFT JOIN');
        }
    });

    it('uses JOIN for ManyToOne custom field relation when sorting', async () => {
        const GET_PRODUCTS = gql`
            query GetProducts($options: ProductListOptions) {
                products(options: $options) {
                    items {
                        id
                    }
                }
            }
        `;

        capturedQueries = [];

        await adminClient.query(GET_PRODUCTS, {
            options: {
                sort: {
                    testManyToOneId: 'ASC',
                },
            },
        });

        const lastQuery = capturedQueries.find(q => q.includes('testManyToOne'));
        expect(lastQuery, 'Should have a query with testManyToOne').toBeDefined();
        if (lastQuery) {
            // Verify JOIN was added for sorting
            expect(lastQuery).toContain('LEFT JOIN');
            // EXISTS is not used for sorting
            const existsCount = (lastQuery.match(/EXISTS/g) || []).length;
            expect(existsCount).toBe(0);
        }
    });
});
