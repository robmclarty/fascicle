<!-- source: https://github.com/reduxjs/redux/blob/master/src/createStore.ts -->

Example full JSDoc-style function description-comment:

First sentence is a single active-voice clause starting with a verb; second beat is the invariant or constraint the caller needs; @param describes the role of the argument, not its type restated; @returns says what you can do with the value; caveats become a numbered list only when behaviour is genuinely subtle.

```ts
/**
 * Creates a Redux store that holds the state tree.
 *
 * **We recommend using `configureStore` from the
 * `@reduxjs/toolkit` package**, which replaces `createStore`:
 * **https://redux.js.org/introduction/why-rtk-is-redux-today**
 *
 * The only way to change the data in the store is to call `dispatch()` on it.
 *
 * There should only be a single store in your app. To specify how different
 * parts of the state tree respond to actions, you may combine several reducers
 * into a single reducer function by using `combineReducers`.
 *
 * @param {Function} reducer A function that returns the next state tree, given
 * the current state tree and the action to handle.
 *
 * @param {any} [preloadedState] The initial state. You may optionally specify it
 * to hydrate the state from the server in universal apps, or to restore a
 * previously serialized user session.
 * If you use `combineReducers` to produce the root reducer function, this must be
 * an object with the same shape as `combineReducers` keys.
 *
 * @param {Function} [enhancer] The store enhancer. You may optionally specify it
 * to enhance the store with third-party capabilities such as middleware,
 * time travel, persistence, etc. The only store enhancer that ships with Redux
 * is `applyMiddleware()`.
 *
 * @returns {Store} A Redux store that lets you read the state, dispatch actions
 * and subscribe to changes.
 */
```

Example function with sub-comments using `//` syntax where `/** */` is reserved
for function descriptions.

```ts
/**
  * Replaces the reducer currently used by the store to calculate the state.
  *
  * You might need this if your app implements code splitting and you want to
  * load some of the reducers dynamically. You might also need this if you
  * implement a hot reloading mechanism for Redux.
  *
  * @param nextReducer The reducer for the store to use instead.
  */
function replaceReducer(nextReducer: Reducer<S, A>): void {
  if (typeof nextReducer !== 'function') {
    throw new Error(
      `Expected the nextReducer to be a function. Instead, received: '${kindOf(
        nextReducer
      )}'`
    )
  }

  currentReducer = nextReducer as unknown as Reducer<S, A, PreloadedState>

  // This action has a similar effect to ActionTypes.INIT.
  // Any reducers that existed in both the new and old rootReducer
  // will receive the previous state. This effectively populates
  // the new state tree with any relevant data from the old one.
  dispatch({ type: ActionTypes.REPLACE } as A)
}
```
