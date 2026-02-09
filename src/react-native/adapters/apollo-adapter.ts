import {
    GraphQLOperation,
    CacheEntry,
    GraphQLSchema,
    OperationType,
} from '../../shared/types';
import { GraphQLClientAdapter, AdapterConfig } from './types';
import { gql, ApolloClient as ApolloClientType, ApolloLink, Observable, FetchResult, Operation } from '@apollo/client';
import {
    getIntrospectionQuery,
    buildClientSchema,
    isObjectType,
    isInterfaceType,
    isUnionType,
    isEnumType,
    isInputObjectType,
    isScalarType,
    print,
} from 'graphql';

// Type alias for Apollo Client
type ApolloClient = ApolloClientType<any>;

/**
 * Apollo Client adapter for the GraphQL DevTools plugin.
 * 
 * This adapter integrates with Apollo Client using Apollo Link middleware
 * to intercept all GraphQL operations with full request/response lifecycle tracking.
 * 
 * IMPORTANT: Add the Rozenite link as the FIRST link in your Apollo Client chain:
 * ```typescript
 * import { ApolloClient, InMemoryCache, ApolloLink, HttpLink } from '@apollo/client';
 * import { apolloGraphqlDevtoolLink } from 'rozenite-graphql-client-devtool';
 * 
 * const client = new ApolloClient({
 *   link: ApolloLink.from([
 *     apolloGraphqlDevtoolLink(),  // Must be first to capture all operations
 *     new HttpLink({ uri: 'https://api.example.com/graphql' }),
 *   ]),
 *   cache: new InMemoryCache(),
 * });
 * 
 * // Then initialize the adapter
 * const adapter = new ApolloClientAdapter(client);
 * adapter.initialize();
 * ```
 */
export class ApolloClientAdapter implements GraphQLClientAdapter {
    private client: ApolloClient;
    private config: Required<AdapterConfig>;
    private operationCallbacks: Set<(operation: GraphQLOperation) => void> = new Set();
    private cacheCallbacks: Set<(entry: CacheEntry) => void> = new Set();
    private operationCounter = 0;

    // ============================================================================
    // Constructor & Configuration
    // ============================================================================

    constructor(client: ApolloClient, config: AdapterConfig = {}) {
        this.client = client;
        this.config = {
            includeVariables: config.includeVariables ?? true,
            includeResponseData: config.includeResponseData ?? true,
            maxOperations: config.maxOperations ?? 1000,
        };
    }

    // ============================================================================
    // Lifecycle Methods
    // ============================================================================

    initialize(): void {
        try {
            // Register this adapter globally so the link can find it
            (globalThis as any).__ROZENITE_APOLLO_ADAPTER__ = this;
        } catch (error) {
            console.error('[Apollo Adapter] Failed to initialize:', error);
        }
    }

    cleanup(): void {
        this.operationCallbacks.clear();
        this.cacheCallbacks.clear();

        // Unregister global adapter
        if ((globalThis as any).__ROZENITE_APOLLO_ADAPTER__ === this) {
            delete (globalThis as any).__ROZENITE_APOLLO_ADAPTER__;
        }
    }

    // ============================================================================
    // Apollo Link Methods (Internal)
    // ============================================================================

    /**
     * Internal method to track an operation through the link
     */
    trackOperation(operation: Operation, forward: any): Observable<FetchResult> {
        const startTime = Date.now();
        const baseOperationId = `${operation.operationName || 'anonymous'}-${this.operationCounter++}-${startTime}`;

        // Extract operation details
        const operationDef = operation.query.definitions.find(
            (def: any) => def.kind === 'OperationDefinition'
        ) as any;
        const operationType = operationDef?.operation || 'query';

        const isSubscription = operationType === 'subscription';

        // For subscriptions, emit an "active" state when first registered (listening for events)
        // For queries/mutations, emit loading state
        const initialOperation: GraphQLOperation = {
            id: baseOperationId,
            operationName: operation.operationName || 'Unnamed Operation',
            operationType: operationType as 'query' | 'mutation' | 'subscription',
            query: print(operation.query),
            variables: this.config.includeVariables ? operation.variables : undefined,
            timestamp: startTime,
            status: isSubscription ? 'active' : 'loading',
            duration: undefined,
            ...(isSubscription && {
                metadata: {
                    isActive: true,
                    eventCount: 0,
                }
            }),
        };

        this.notifyOperationCallbacks(initialOperation);

        // Forward the operation and capture response
        let eventCount = 0;

        return new Observable((observer) => {
            const subscription = forward(operation).subscribe({
                next: (result: FetchResult) => {
                    eventCount++;
                    const eventTime = Date.now();
                    const duration = eventTime - startTime;
                    const status = result.errors ? 'error' : 'success';

                    // For subscriptions: Create a NEW operation entry for EACH event
                    // For queries/mutations: Update the existing operation
                    const operationId = isSubscription
                        ? `${baseOperationId}-event-${eventCount}`
                        : baseOperationId;

                    const operationUpdate: GraphQLOperation = {
                        id: operationId,
                        operationName: operation.operationName || 'Unnamed Operation',
                        operationType: operationType as 'query' | 'mutation' | 'subscription',
                        query: print(operation.query),
                        variables: this.config.includeVariables ? operation.variables : undefined,
                        timestamp: isSubscription ? eventTime : startTime, // Use event time for subscription events
                        status,
                        duration: isSubscription ? eventTime - startTime : duration,
                        data: this.config.includeResponseData ? result.data : undefined,
                        error: result.errors ? {
                            message: result.errors.map(e => e.message).join(', '),
                            extensions: result.errors[0]?.extensions,
                        } : undefined,
                        // Add metadata for subscriptions to link events to parent
                        ...(isSubscription && {
                            metadata: {
                                parentId: baseOperationId,
                                eventNumber: eventCount,
                                isActive: true,
                            }
                        }),
                    };

                    this.notifyOperationCallbacks(operationUpdate);
                    observer.next(result);
                },
                error: (error: Error) => {
                    const duration = Date.now() - startTime;

                    // Emit error operation
                    const errorOperation: GraphQLOperation = {
                        id: baseOperationId,
                        operationName: operation.operationName || 'Unnamed Operation',
                        operationType: operationType as 'query' | 'mutation' | 'subscription',
                        query: print(operation.query),
                        variables: this.config.includeVariables ? operation.variables : undefined,
                        timestamp: startTime,
                        status: 'error',
                        duration,
                        error: {
                            message: error.message || 'Network error',
                        },
                    };

                    this.notifyOperationCallbacks(errorOperation);
                    observer.error(error);
                },
                complete: () => {
                    // For subscriptions, emit a final update when they complete/unsubscribe
                    if (isSubscription && eventCount > 0) {
                        const duration = Date.now() - startTime;
                        const completedOperation: GraphQLOperation = {
                            id: `${baseOperationId}-completed`,
                            operationName: operation.operationName || 'Unnamed Operation',
                            operationType: 'subscription',
                            query: print(operation.query),
                            variables: this.config.includeVariables ? operation.variables : undefined,
                            timestamp: Date.now(),
                            status: 'success',
                            duration,
                            metadata: {
                                parentId: baseOperationId,
                                eventCount,
                                isActive: false,
                                completed: true
                            }
                        };
                        this.notifyOperationCallbacks(completedOperation);
                    }
                    observer.complete();
                },
            });

            return () => {
                subscription.unsubscribe();
            };
        });
    }

    // ============================================================================
    // Public API Methods
    // ============================================================================

    getCacheSnapshot(): CacheEntry[] {
        try {
            // Extract cache data from Apollo Client
            const cacheData = this.client.cache.extract();
            const entries: CacheEntry[] = [];

            Object.entries(cacheData).forEach(([key, value]) => {
                entries.push({
                    id: key,
                    key: key,
                    typename: (value as any)?.__typename,
                    data: value,
                    timestamp: Date.now(),
                });
            });

            return entries;
        } catch (error) {
            console.error('[Apollo Adapter] Failed to extract cache:', error);
            return [];
        }
    }

    async getSchema(): Promise<GraphQLSchema> {
        try {
            // Execute introspection query
            const result = await this.client.query({
                query: gql(getIntrospectionQuery()),
                fetchPolicy: 'network-only',
            });

            if (!result.data) {
                console.warn('[Apollo Adapter] No schema data returned');
                return { types: [] };
            }

            // Build client schema from introspection result
            const schema = buildClientSchema(result.data);

            // Extract query, mutation, and subscription types
            const queryType = schema.getQueryType();
            const mutationType = schema.getMutationType();
            const subscriptionType = schema.getSubscriptionType();

            // Helper to convert fields
            const convertFields = (fields: any) => {
                if (!fields) return undefined;

                return Object.values(fields).map((field: any) => ({
                    name: field.name,
                    type: field.type.toString(),
                    description: field.description,
                    args: field.args?.map((arg: any) => ({
                        name: arg.name,
                        type: arg.type.toString(),
                        description: arg.description,
                        defaultValue: arg.defaultValue,
                    })),
                    isDeprecated: field.isDeprecated,
                    deprecationReason: field.deprecationReason,
                }));
            };

            // Extract all types from schema
            const typeMap = schema.getTypeMap();
            const allTypes = Object.values(typeMap)
                .filter((type: any) => {
                    // Filter out built-in types (starting with __)
                    return !type.name.startsWith('__');
                })
                .map((type: any) => {
                    // Determine type kind using GraphQL type guards
                    let kind: 'OBJECT' | 'INTERFACE' | 'UNION' | 'ENUM' | 'INPUT_OBJECT' | 'SCALAR' = 'OBJECT';
                    if (isScalarType(type)) {
                        kind = 'SCALAR';
                    } else if (isEnumType(type)) {
                        kind = 'ENUM';
                    } else if (isInputObjectType(type)) {
                        kind = 'INPUT_OBJECT';
                    } else if (isInterfaceType(type)) {
                        kind = 'INTERFACE';
                    } else if (isUnionType(type)) {
                        kind = 'UNION';
                    } else if (isObjectType(type)) {
                        kind = 'OBJECT';
                    }

                    const typeObj: any = {
                        name: type.name,
                        kind,
                        description: type.description,
                    };

                    // Add fields for object and interface types
                    if ((isObjectType(type) || isInterfaceType(type) || isInputObjectType(type)) && type.getFields) {
                        try {
                            typeObj.fields = convertFields(type.getFields());
                        } catch (e) {
                            // Some types might not have fields
                        }
                    }

                    // Add enum values
                    if (isEnumType(type) && type.getValues) {
                        try {
                            typeObj.enumValues = type.getValues().map((v: any) => v.name);
                        } catch (e) {
                            // Error getting enum values
                        }
                    }

                    // Add interfaces (for object types)
                    if (isObjectType(type) && type.getInterfaces) {
                        try {
                            typeObj.interfaces = type.getInterfaces().map((i: any) => i.name);
                        } catch (e) {
                            // No interfaces
                        }
                    }

                    // Add possible types for unions/interfaces
                    if ((isUnionType(type) || isInterfaceType(type)) && schema.getPossibleTypes) {
                        try {
                            typeObj.possibleTypes = schema.getPossibleTypes(type).map((t: any) => t.name);
                        } catch (e) {
                            // No possible types
                        }
                    }

                    return typeObj;
                });

            return {
                queryType: queryType ? {
                    name: queryType.name,
                    kind: 'OBJECT' as const,
                    fields: convertFields(queryType.getFields()),
                    description: queryType.description,
                } : undefined,
                mutationType: mutationType ? {
                    name: mutationType.name,
                    kind: 'OBJECT' as const,
                    fields: convertFields(mutationType.getFields()),
                    description: mutationType.description,
                } : undefined,
                subscriptionType: subscriptionType ? {
                    name: subscriptionType.name,
                    kind: 'OBJECT' as const,
                    fields: convertFields(subscriptionType.getFields()),
                    description: subscriptionType.description,
                } : undefined,
                types: allTypes,
            };
        } catch (error) {
            console.error('[Apollo Adapter] Failed to fetch schema:', error);
            return { types: [] };
        }
    }

    onOperation(callback: (operation: GraphQLOperation) => void): () => void {
        this.operationCallbacks.add(callback);
        return () => {
            this.operationCallbacks.delete(callback);
        };
    }

    onCacheChange(callback: (entry: CacheEntry) => void): () => void {
        this.cacheCallbacks.add(callback);
        return () => {
            this.cacheCallbacks.delete(callback);
        };
    }

    // ============================================================================
    // Private Helper Methods
    // ============================================================================

    /**
     * Helper method to notify all operation callbacks
     */
    private notifyOperationCallbacks(operation: GraphQLOperation): void {
        this.operationCallbacks.forEach((callback) => {
            try {
                callback(operation);
            } catch (error) {
                console.error('[Apollo Adapter] Error in operation callback:', error);
            }
        });
    }
}

/**
 * Helper function to create a Rozenite DevTools Link for Apollo Client.
 * 
 * This link intercepts all GraphQL operations (queries, mutations, subscriptions)
 * and captures their complete lifecycle including request/response data.
 * 
 * **IMPORTANT**: Add this as the FIRST link in your Apollo Client chain to ensure
 * all operations are captured, including duplicates that may be deduplicated later.
 * 
 * @example
 * ```typescript
 * import { ApolloClient, InMemoryCache, ApolloLink, HttpLink } from '@apollo/client';
 * import { apolloGraphqlDevtoolLink, useGraphqlClientDevtool } from 'rozenite-graphql-client-devtool';
 * 
 * // 1. Create the link
 * const rozeniteLink = apolloGraphqlDevtoolLink();
 * 
 * // 2. Add as FIRST link in the chain
 * const client = new ApolloClient({
 *   link: ApolloLink.from([
 *     rozeniteLink,  // Must be first to capture ALL operations
 *     new HttpLink({ uri: 'https://api.example.com/graphql' }),
 *   ]),
 *   cache: new InMemoryCache(),
 * });
 * 
 * // 3. Initialize the devtool in your component
 * function App() {
 *   useGraphqlClientDevtool({
 *     client,
 *     clientType: 'apollo',
 *   });
 *   
 *   return <YourApp />;
 * }
 * ```
 * 
 * @returns ApolloLink instance configured for Rozenite DevTools
 */
export function apolloGraphqlDevtoolLink(): ApolloLink {
    return new ApolloLink((operation: Operation, forward) => {
        // Find the adapter instance from the global registry
        const adapter = (globalThis as any).__ROZENITE_APOLLO_ADAPTER__;

        // Use duck typing instead of instanceof to avoid module bundling issues
        if (adapter && typeof adapter.trackOperation === 'function') {
            // Use the adapter's track operation method
            return adapter.trackOperation(operation, forward);
        }

        // If no adapter found, just pass through (devtool not initialized yet)
        return forward(operation);
    });
}

