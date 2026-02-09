export let useGraphqlClientDevtool: typeof import('./src/react-native/useGraphqlClientDevtool').useGraphqlClientDevtool;
export let apolloGraphqlDevtoolLink: typeof import('./src/react-native/adapters/apollo-adapter').apolloGraphqlDevtoolLink;

const isWeb =
    typeof window !== 'undefined' && window.navigator.product !== 'ReactNative';
const isDev = process.env.NODE_ENV !== 'production';
const isServer = typeof window === 'undefined';

if (isDev && !isWeb && !isServer) {
    useGraphqlClientDevtool =
        require('./src/react-native/useGraphqlClientDevtool').useGraphqlClientDevtool;
    apolloGraphqlDevtoolLink =
        require('./src/react-native/adapters/apollo-adapter').apolloGraphqlDevtoolLink;
} else {
    useGraphqlClientDevtool = () => null as any;
    apolloGraphqlDevtoolLink = () => null as any;
}
