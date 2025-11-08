import { assign, createActor, fromPromise, raise, setup } from "xstate";
import { speechstate } from "speechstate";
import type { Settings } from "speechstate";

import type { DMEvents, DMContext, Message } from "./types";

import { KEY } from "./azure.ts";

const azureCredentials = {
  endpoint:
    "https://northeurope.api.cognitive.microsoft.com/sts/v1.0/issuetoken",
  key: KEY,
};

const settings: Settings = {
  azureCredentials: azureCredentials,
  azureRegion: "northeurope",
  asrDefaultCompleteTimeout: 0,
  asrDefaultNoInputTimeout: 5000,
  locale: "en-US",
  ttsDefaultVoice: "en-US-DavisNeural",
};

const dmMachine = setup({
  types: {
    /** you might need to extend these */
    context: {} as DMContext,
    events: {} as DMEvents,
  },
  actions: {
        "print": ({ context }) => console.log(context.messages),
        "spst.speak": ({ context }, params: { utterance: string }) =>
      context.spstRef.send({
        type: "SPEAK",
        value: {
          utterance: params.utterance,
        },
      }),
          "spst.listen": ({ context }) =>
      context.spstRef.send({
        type: "LISTEN",
      }),

    sst_prepare: ({ context }) => context.spstRef.send({ type: "PREPARE" }),
    sst_listen: ({ context }) => context.spstRef.send({ type: "LISTEN" }),
  },
  actors: {
    getModels: fromPromise<any, null>(() => fetch("http://localhost:11434/api/tags").then((response) => response.json())),
    getLLMansw: fromPromise<any, Message[]>(({input}) => {
                                              const body = {
                                                model: "llama3.1",
                                                // model: "gemma2",
                                                stream: false,
                                                messages: input
                                              };
                                              return fetch("http://localhost:11434/api/chat", {
                                                method: "POST",
                                                body: JSON.stringify(body),
                                              }).then((response) => response.json());
                                            })
  },
}).createMachine({
  id: "DM",
  context: ({ spawn }) => ({
    spstRef: spawn(speechstate, { input: settings }),
    informationState: { latestMove: "ping" },
    lastResult: "",
    messages: [],
    ollamaModels: [],
  }),
  initial: "Prepare",
  states: {

    Prepare: {
      entry: "sst_prepare",
      on: {
        ASRTTS_READY: "Add_first_message",
      },
    },

    Add_first_message: {
      entry: assign(({ context }) => ({
        messages: [
          ...(context.messages),
          { role: "assistant", content: "Greet the user, tell them they can ask anything. One sentence only" },
          // { role: "system", content: "Greet the user, tell them they can ask anything. One sentence only" },

        ],
      })),
      always: {target: "LLMGreeting"},
    },

    Done: {
      type: "final",
    },

    LLMGreeting: {
      invoke: {
        src: "getLLMansw",
        input: ({ context }) => context.messages,
        onDone: {
          target: "greeting", 

          actions: assign(({context, event}) => {
            return {
              messages: [
                ...(context.messages),
                { role: "system", content: event.output.message.content},
                // { role: "assistant", content: event.output.message.content},
              ],
            };
          }),
        },
      },
    },   

    greeting: {
        entry: {
          type: "spst.speak",
          params: ({context}) => ({utterance: `${context.messages[context.messages.length - 1].content}`}),
        },
          on: { SPEAK_COMPLETE: "Loop" },
     },

    Loop: {
        initial: "Ask",
        states:{
          Speaking: {
            entry: ({context}) => context.spstRef.send({
                                                      type:"SPEAK",
                                                      value: { utterance: context.messages[context.messages.length - 1].content},
                                                      }),
            on: {"SPEAK_COMPLETE": "Ask"},
          },

          Ask: {
            entry: "sst_listen",
            on: {
            LISTEN_COMPLETE: "ChatCompletion",
            RECOGNISED:{
              actions: [
                assign(({ context, event }) => ({
                  messages: [
                    ...(context.messages),
                    { role: "user", content: event.value[0].utterance },

                  ],
                })),
                // assign(event) => console.log((event as any).output),
              ],
            },
            ASR_NOINPUT: {
              actions: assign(({ context }) => ({
                  messages: [
                    ...(context.messages),

                    // { role: "assistant", content: "Tell the user that the system didn't hear anything" },
                    // { role: "system", content: "Tell the user that the system didn't hear anything" },
                    { role: "user", content: "Tell the user you didn't hear anything" },
                  ],
                })),
            },
            },
          },


          ChatCompletion: {
            entry:"print",
              invoke: {
              src: "getLLMansw",
              input: ({ context }: { context: DMContext }) => context.messages,
              onDone: {
                target: "Speaking",
                actions: assign(({ context, event }: { context: DMContext; event: any }) => {
                  return {
                    messages: [
                      ...(context.messages),
                      { role: "system", content: (event as any).output.message.content },
                      // { role: "assistant", content: (event as any).output.message.content },
                    ],
                  };
                }),
              },
            },
          },
  },
},
  },
});

const dmActor = createActor(dmMachine, {}).start();

dmActor.subscribe((state) => {
  console.group("State update");
  console.log("State value:", state.value);
  console.log("State context:", state.context);
  console.groupEnd();
});

export function setupButton(element: HTMLButtonElement) {
  element.addEventListener("click", () => {
    dmActor.send({ type: "CLICK" });
  });
  dmActor.subscribe((snapshot) => {
    const meta: { view?: string } = Object.values(
      snapshot.context.spstRef.getSnapshot().getMeta()
    )[0] || {
      view: undefined,
    };
    element.innerHTML = `${meta.view}`;
  });
}
