---
id: part-4-store
title: 'Redux Fundamentals, Part 4: Store'
sidebar_label: 'Store'
description: 'The official Redux Fundamentals tutorial: learn how to create and use a Redux store'
---
<!-- source: https://github.com/reduxjs/redux/blob/master/docs/tutorials/fundamentals/part-4-store.md -->


import { DetailedExplanation } from '../../components/DetailedExplanation'

<!-- prettier-ignore -->
import FundamentalsWarning from "../../components/_FundamentalsWarning.mdx";

:::tip What You'll Learn

- How to create a Redux store
- How to use the store to update state and listen for updates
- How to configure the store to extend its capabilities
- How to set up the Redux DevTools Extension to debug your app

:::

## Introduction

In [Part 3: State, Actions, and Reducers](./part-3-state-actions-reducers.md), we started writing our example todo app. We
listed business requirements, defined the **state** structure we need to make the app work, and created a series of action types
to describe "what happened" and match the kinds of events that can happen as a user interacts with our app. We also wrote **reducer** functions that can handle updating our `state.todos` and `state.filters` sections, and saw how we can use the Redux `combineReducers` function
to create a "root reducer" based on the different "slice reducers" for each feature in our app.

Now, it's time to pull those pieces together, with the central piece of a Redux app: the **store**.

<FundamentalsWarning />

## Redux Store

The Redux **store** brings together the state, actions, and reducers that make up your app. The store has several responsibilities:

- Holds the current application state inside
- Allows access to the current state via [`store.getState()`](../../api/Store.md#getState);
- Allows state to be updated via [`store.dispatch(action)`](../../api/Store.md#dispatch);
- Registers listener callbacks via [`store.subscribe(listener)`](../../api/Store.md#subscribe);
- Handles unregistering of listeners via the `unsubscribe` function returned by [`store.subscribe(listener)`](../../api/Store.md#subscribe).

It's important to note that **you'll only have a single store in a Redux application**. When you want to split your data handling logic, you'll use [reducer composition](./part-3-state-actions-reducers.md#splitting-reducers) and create multiple reducers that
can be combined together, instead of creating separate stores.

### Creating a Store

**Every Redux store has a single root reducer function**. In the previous section, we [created a root reducer function using `combineReducers`](./part-3-state-actions-reducers.md#combinereducers). That root reducer is currently defined in `src/reducer.js` in our example app. Let's import that root reducer and create our first store.

The Redux core library has [**a `createStore` API**](../../api/createStore.md) that will create the store. Add a new file
called `store.js`, and import `createStore` and the root reducer. Then, call `createStore` and pass in the root reducer:

```js title="src/store.js"
import { createStore } from 'redux'
import rootReducer from './reducer'

// highlight-next-line
const store = createStore(rootReducer)

export default store
```

### Loading Initial State

`createStore` can also accept a `preloadedState` value as its second argument. You could use this to add
initial data when the store is created, such as values that were included in an HTML page sent from the server, or persisted in
`localStorage` and read back when the user visits the page again, like this:

```js title="storeStatePersistenceExample.js"
import { createStore } from 'redux'
import rootReducer from './reducer'

// highlight-start
let preloadedState
const persistedTodosString = localStorage.getItem('todos')

if (persistedTodosString) {
  preloadedState = {
    todos: JSON.parse(persistedTodosString)
  }
}

const store = createStore(rootReducer, preloadedState)
// highlight-end
```

## Dispatching Actions

Now that we have created a store, let's verify our program works! Even without any UI, we can already test the update logic.

:::tip

Before you run this code, try going back to `src/features/todos/todosSlice.js`, and remove all the example todo objects from the `initialState` so that it's an empty array. That will make the output from this example a bit easier to read.

:::

```js title="src/index.js"
// Omit existing React imports

import store from './store'

// Log the initial state
// highlight-next-line
console.log('Initial state: ', store.getState())
// {todos: [....], filters: {status, colors}}

// Every time the state changes, log it
// Note that subscribe() returns a function for unregistering the listener
// highlight-start
const unsubscribe = store.subscribe(() =>
  console.log('State after dispatch: ', store.getState())
)
// highlight-end

// Now, dispatch some actions

// highlight-next-line
store.dispatch({ type: 'todos/todoAdded', payload: 'Learn about actions' })
store.dispatch({ type: 'todos/todoAdded', payload: 'Learn about reducers' })
store.dispatch({ type: 'todos/todoAdded', payload: 'Learn about stores' })

store.dispatch({ type: 'todos/todoToggled', payload: 0 })
store.dispatch({ type: 'todos/todoToggled', payload: 1 })

store.dispatch({ type: 'filters/statusFilterChanged', payload: 'Active' })

store.dispatch({
  type: 'filters/colorFilterChanged',
  payload: { color: 'red', changeType: 'added' }
})

// Stop listening to state updates
// highlight-next-line
unsubscribe()

// Dispatch one more action to see what happens

store.dispatch({ type: 'todos/todoAdded', payload: 'Try creating a store' })

// Omit existing React rendering logic
```

Remember, every time we call `store.dispatch(action)`:

- The store calls `rootReducer(state, action)`
  - That root reducer may call other slice reducers inside of itself, like `todosReducer(state.todos, action)`
- The store saves the _new_ state value inside
- The store calls all the listener subscription callbacks
- If a listener has access to the `store`, it can now call `store.getState()` to read the latest state value

If we look at the console log output from that example, you can see how the
Redux state changes as each action was dispatched:

![Logged Redux state after dispatching actions](/img/tutorials/fundamentals/initial-state-updates.png)

Notice that our app did _not_ log anything from the last action. That's because we removed the listener callback when we called `unsubscribe()`, so nothing else ran after the action was dispatched.

We specified the behavior of our app before we even started writing the UI. That
helps give us confidence that the app will work as intended.

:::info

If you want, you can now try writing tests for your reducers. Because they're [pure functions](../../understanding/thinking-in-redux/ThreePrinciples.md#changes-are-made-with-pure-functions), it should be straightforward to test them. Call them with an example `state` and `action`,
take the result, and check to see if it matches what you expect:

```js title="todosSlice.spec.js"
import todosReducer from './todosSlice'

test('Toggles a todo based on id', () => {
  const initialState = [{ id: 0, text: 'Test text', completed: false }]

  const action = { type: 'todos/todoToggled', payload: 0 }
  const result = todosReducer(initialState, action)
  expect(result[0].completed).toBe(true)
})
```

:::

## Inside a Redux Store

It might be helpful to take a peek inside a Redux store to see how it works. Here's a miniature example of a working Redux store, in about 25 lines of code:

```js title="miniReduxStoreExample.js"
function createStore(reducer, preloadedState) {
  let state = preloadedState
  const listeners = []

  function getState() {
    return state
  }

  function subscribe(listener) {
    listeners.push(listener)
    return function unsubscribe() {
      const index = listeners.indexOf(listener)
      listeners.splice(index, 1)
    }
  }

  function dispatch(action) {
    state = reducer(state, action)
    listeners.forEach(listener => listener())
  }

  dispatch({ type: '@@redux/INIT' })

  return { dispatch, subscribe, getState }
}
```

This small version of a Redux store works well enough that you could use it to replace the actual Redux `createStore` function you've been using in your app so far. (Try it and see for yourself!) [The actual Redux store implementation is longer and a bit more complicated](https://github.com/reduxjs/redux/blob/v4.0.5/src/createStore.js), but most of that is comments, warning messages, and handling some edge cases.

As you can see, the actual logic here is fairly short:

- The store has the current `state` value and `reducer` function inside of itself
- `getState` returns the current state value
- `subscribe` keeps an array of listener callbacks and returns a function to remove the new callback
- `dispatch` calls the reducer, saves the state, and runs the listeners
- The store dispatches one action on startup to initialize the reducers with their state
- The store API is an object with `{dispatch, subscribe, getState}` inside

To emphasize one of those in particular: notice that `getState` just returns whatever the current `state` value is. That means that **by default, nothing prevents you from accidentally mutating the current state value!** This code will run without any errors, but it's incorrect:

```js
const state = store.getState()
// ❌ Don't do this - it mutates the current state!
state.filters.status = 'Active'
```

In other words:

- The Redux store doesn't make an extra copy of the `state` value when you call `getState()`. It's exactly the same reference that was returned from the root reducer function
- The Redux store doesn't do anything else to prevent accidental mutations. It _is_ possible to mutate the state, either inside a reducer or outside the store, and you must always be careful to avoid mutations.

One common cause of accidental mutations is sorting arrays. [**Calling `array.sort()` actually mutates the existing array**](https://doesitmutate.xyz/sort/). If we called `const sortedTodos = state.todos.sort()`, we'd end up mutating the real store state unintentionally.

:::tip

In [Part 8: Modern Redux](./part-8-modern-redux.md), we'll see how Redux Toolkit helps avoid mutations in reducers, and detects and warns about accidental mutations outside of reducers.

:::


<!--
  Trimmed here; 398 more lines upstream. Through "Inside a Redux Store", which is where the teaching move is clearest.
-->