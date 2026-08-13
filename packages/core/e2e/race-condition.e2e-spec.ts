import { createTestEnvironment } from '@vendure/testing';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { initialData } from '../../e2e-common/e2e-initial-data';
import { TEST_SETUP_TIMEOUT_MS, testConfig } from '../../e2e-common/test-config';

describe('Order race conditions', () => {
    const { server, adminClient, shopClient } = createTestEnvironment(testConfig());

    beforeAll(async () => {
        await server.init({
            initialData,
            productsCsvPath: path.join(__dirname, '../../e2e-common/fixtures/e2e-products-full.csv'),
            customerCount: 1,
        });
        await shopClient.asUserWithCredentials('test@vendure.io', 'test');
    }, TEST_SETUP_TIMEOUT_MS);

    afterAll(async () => {
        await server.destroy();
    });

    it('handles parallel modifications to the order correctly', async () => {
        const { products } = await shopClient.query(`
            query GetProducts {
                products(options: { take: 1 }) {
                    items {
                        variants {
                            id
                        }
                    }
                }
            }
        `);
        const variantId = products.items[0].variants[0].id;

        const ADD_ITEM_TO_ORDER = `
            mutation AddItemToOrder($productVariantId: ID!, $quantity: Int!) {
                addItemToOrder(productVariantId: $productVariantId, quantity: $quantity) {
                    ... on Order {
                        id
                        totalQuantity
                        total
                    }
                    ... on ErrorResult {
                        errorCode
                        message
                    }
                }
            }
        `;

        const quantityPerRequest = 1;
        const concurrency = 5;

        // Executing 5 simultaneous requests to add an item
        const promises: Array<Promise<any>> = [];
        for (let i = 0; i < concurrency; i++) {
            promises.push(
                shopClient.query(ADD_ITEM_TO_ORDER, {
                    productVariantId: variantId,
                    quantity: quantityPerRequest,
                }),
            );
        }

        await Promise.all(promises);

        const { activeOrder } = await shopClient.query(`
            query GetActiveOrder { activeOrder { totalQuantity } }
        `);

        // If there is a race condition, the total will be less than 5 (some writes overwritten)
        expect(activeOrder.totalQuantity).toBe(concurrency * quantityPerRequest);
    });

    it('handles parallel adjustOrderLines correctly', async () => {
        const { products } = await shopClient.query(`
            query GetProducts {
                products(options: { take: 1 }) {
                    items {
                        variants {
                            id
                        }
                    }
                }
            }
        `);
        const variantId = products.items[0].variants[0].id;

        // First add an item to create the order line
        await shopClient.query(`
            mutation AddItem($productVariantId: ID!, $quantity: Int!) {
                addItemToOrder(productVariantId: $productVariantId, quantity: $quantity) {
                    ... on Order {
                        id
                        totalQuantity
                    }
                }
            }
        `, { productVariantId: variantId, quantity: 1 });

        const { activeOrder } = await shopClient.query(`
            query GetActiveOrder { 
                activeOrder { 
                    id 
                    lines { 
                        id 
                        quantity 
                    } 
                } 
            }
        `);
        const orderId = activeOrder.id;
        const lineId = activeOrder.lines[0].id;
        const initialQuantity = activeOrder.lines[0].quantity;

        const ADJUST_ORDER_LINE = `
            mutation AdjustOrderLine($orderId: ID!, $orderLineId: ID!, $quantity: Int!) {
                adjustOrderLine(orderId: $orderId, orderLineId: $orderLineId, quantity: $quantity) {
                    ... on Order {
                        id
                        totalQuantity
                    }
                    ... on ErrorResult {
                        errorCode
                        message
                    }
                }
            }
        `;

        const quantityPerRequest = 1;
        const concurrency = 5;

        // Execute 5 simultaneous requests to adjust the same line
        const promises: Array<Promise<any>> = [];
        for (let i = 0; i < concurrency; i++) {
            promises.push(
                shopClient.query(ADJUST_ORDER_LINE, {
                    orderId,
                    orderLineId: lineId,
                    quantity: initialQuantity + quantityPerRequest,
                }),
            );
        }

        await Promise.all(promises);

        const { activeOrder: finalOrder } = await shopClient.query(`
            query GetActiveOrder { activeOrder { totalQuantity } }
        `);

        // Each request submits an absolute quantity of initialQuantity + quantityPerRequest.
        // After serialization, the last request wins, so the final quantity should be
        // initialQuantity + quantityPerRequest (not initialQuantity + concurrency).
        expect(finalOrder.totalQuantity).toBe(initialQuantity + quantityPerRequest);
    });

    it('handles parallel applyCouponCode correctly', async () => {
        // Create a promotion with usageLimit: 1 for this test
        const createPromotion = await adminClient.query(`
            mutation CreatePromotion($input: CreatePromotionInput!) {
                createPromotion(input: $input) {
                    id
                    couponCode
                    usageLimit
                }
            }
        `, {
            input: {
                name: 'Race condition test promotion',
                couponCode: 'RACE1',
                usageLimit: 1,
                enabled: true,
                rules: [],
                actions: [],
            }
        });

        const promotionId = createPromotion.createPromotion.id;

        const APPLY_COUPON = `
            mutation ApplyCoupon($orderId: ID!, $couponCode: String!) {
                applyCouponCode(orderId: $orderId, couponCode: $couponCode) {
                    ... on Order {
                        id
                        couponCodes
                    }
                    ... on ErrorResult {
                        errorCode
                    }
                }
            }
        `;

        const { activeOrder } = await shopClient.query(`
            query GetActiveOrder { activeOrder { id } }
        `);
        const orderId = activeOrder.id;

        const concurrency = 3;
        const promises: Array<Promise<any>> = [];
        for (let i = 0; i < concurrency; i++) {
            promises.push(
                shopClient.query(APPLY_COUPON, { orderId, couponCode: 'RACE1' }),
            );
        }

        await Promise.all(promises);

        const { activeOrder: finalOrder } = await shopClient.query(`
            query GetActiveOrder { activeOrder { couponCodes } }
        `);

        // Only one request should successfully apply the coupon (usageLimit: 1)
        const raceConditionPromotionCount = finalOrder.couponCodes.filter((c: string) => c === 'RACE1').length;
        expect(raceConditionPromotionCount).toBeLessThanOrEqual(1);
    });

    it('handles parallel setShippingAddress correctly', async () => {
        const { activeOrder } = await shopClient.query(`
            query GetActiveOrder { activeOrder { id } }
        `);
        const orderId = activeOrder.id;

        const SET_SHIPPING_ADDRESS = `
            mutation SetShippingAddress($orderId: ID!, $input: CreateAddressInput!) {
                setShippingAddress(orderId: $orderId, input: $input) {
                    ... on Order {
                        id
                        shippingAddress {
                            streetLine1
                        }
                    }
                }
            }
        `;

        const concurrency = 3;
        const promises: Array<Promise<any>> = [];
        for (let i = 0; i < concurrency; i++) {
            promises.push(
                shopClient.query(SET_SHIPPING_ADDRESS, {
                    orderId,
                    input: {
                        streetLine1: `Street ${i}`,
                        city: 'Test City',
                        province: 'Test Province',
                        postalCode: '12345',
                        countryCode: 'US',
                    },
                }),
            );
        }

        await Promise.all(promises);

        const { activeOrder: finalOrder } = await shopClient.query(`
            query GetActiveOrder { activeOrder { shippingAddress { streetLine1 } } }
        `);

        // The final address should be one of the submitted values (no lost update / overwrite)
        const finalStreet = finalOrder.shippingAddress.streetLine1;
        expect(['Street 0', 'Street 1', 'Street 2']).toContain(finalStreet);
    });
});
