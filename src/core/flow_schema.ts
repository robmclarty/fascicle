/**
 * JSON Schema for the YAML flow representation, exported as `flow_schema`.
 *
 * It lives in a TypeScript module, not a .json file, because the published
 * declarations come from tsgo under TypeScript 7, and tsgo writes none for a
 * JSON module, which leaves the build nothing to type this export with.
 */
export const flow_schema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://robmclarty.dev/schemas/flow-schema.json",
  "title": "fascicle Flow DSL",
  "description": "YAML/JSON representation of a composition tree. Documentation-only in v1.",
  "type": "array",
  "items": { "$ref": "#/$defs/compose_entry" },
  "$defs": {
    "compose_entry": {
      "type": "object",
      "required": ["compose"],
      "properties": {
        "compose": { "type": "string" }
      },
      "allOf": [{ "$ref": "#/$defs/node" }]
    },
    "node": {
      "type": "object",
      "anyOf": [
        { "required": ["step"] },
        { "required": ["sequence"] },
        { "required": ["parallel"] },
        { "required": ["branch"] },
        { "required": ["map"] },
        { "required": ["pipe"] },
        { "required": ["retry"] },
        { "required": ["fallback"] },
        { "required": ["timeout"] },
        { "required": ["loop"] },
        { "required": ["compose_node"] },
        { "required": ["adversarial"] },
        { "required": ["ensemble"] },
        { "required": ["tournament"] },
        { "required": ["consensus"] },
        { "required": ["ensemble_step"] },
        { "required": ["gate"] },
        { "required": ["improve"] },
        { "required": ["learn"] },
        { "required": ["checkpoint"] },
        { "required": ["suspend"] },
        { "required": ["scope"] },
        { "required": ["chain"] },
        { "required": ["ref"] }
      ],
      "properties": {
        "step": { "$ref": "#/$defs/step_config" },
        "sequence": { "$ref": "#/$defs/sequence_config" },
        "parallel": { "$ref": "#/$defs/parallel_config" },
        "branch": { "$ref": "#/$defs/branch_config" },
        "map": { "$ref": "#/$defs/map_config" },
        "pipe": { "$ref": "#/$defs/pipe_config" },
        "retry": { "$ref": "#/$defs/retry_config" },
        "fallback": { "$ref": "#/$defs/fallback_config" },
        "timeout": { "$ref": "#/$defs/timeout_config" },
        "loop": { "$ref": "#/$defs/loop_config" },
        "compose_node": { "$ref": "#/$defs/compose_node_config" },
        "adversarial": { "$ref": "#/$defs/adversarial_config" },
        "ensemble": { "$ref": "#/$defs/ensemble_config" },
        "tournament": { "$ref": "#/$defs/tournament_config" },
        "consensus": { "$ref": "#/$defs/consensus_config" },
        "ensemble_step": { "$ref": "#/$defs/ensemble_step_config" },
        "gate": { "$ref": "#/$defs/gate_config" },
        "improve": { "$ref": "#/$defs/improve_config" },
        "learn": { "$ref": "#/$defs/learn_config" },
        "checkpoint": { "$ref": "#/$defs/checkpoint_config" },
        "suspend": { "$ref": "#/$defs/suspend_config" },
        "scope": { "$ref": "#/$defs/scope_config" },
        "chain": { "$ref": "#/$defs/chain_config" },
        "ref": { "type": "string" }
      }
    },
    "step_config": {
      "type": "object",
      "required": ["fn"],
      "properties": {
        "id": { "type": "string" },
        "fn": { "type": "string" },
        "name": { "type": "string" },
        "description": { "type": "string" },
        "side_effect": { "type": "boolean" },
        "port_labels": {
          "type": "object",
          "properties": {
            "in": { "type": "string" },
            "out": { "type": "string" }
          }
        },
        "arm": { "$ref": "#/$defs/arms" }
      }
    },
    "arms": {
      "anyOf": [
        { "$ref": "#/$defs/node" },
        { "type": "array", "items": { "$ref": "#/$defs/node" } }
      ]
    },
    "sequence_config": {
      "type": "array",
      "items": { "$ref": "#/$defs/node" }
    },
    "parallel_config": {
      "type": "object",
      "additionalProperties": { "$ref": "#/$defs/node" }
    },
    "branch_config": {
      "type": "object",
      "required": ["when", "then", "otherwise"],
      "properties": {
        "name": { "type": "string" },
        "description": { "type": "string" },
        "when": { "type": "string" },
        "then": { "$ref": "#/$defs/node" },
        "otherwise": { "$ref": "#/$defs/node" }
      }
    },
    "map_config": {
      "type": "object",
      "required": ["items", "do"],
      "properties": {
        "name": { "type": "string" },
        "description": { "type": "string" },
        "items": { "type": "string" },
        "do": { "$ref": "#/$defs/node" },
        "concurrency": { "type": "integer", "minimum": 1 },
        "settle": { "type": "boolean" }
      }
    },
    "pipe_config": {
      "type": "object",
      "required": ["of", "fn"],
      "properties": {
        "name": { "type": "string" },
        "description": { "type": "string" },
        "of": { "$ref": "#/$defs/node" },
        "fn": { "type": "string" }
      }
    },
    "retry_config": {
      "type": "object",
      "required": ["do", "max_attempts"],
      "properties": {
        "name": { "type": "string" },
        "description": { "type": "string" },
        "do": { "$ref": "#/$defs/node" },
        "max_attempts": { "type": "integer", "minimum": 1 },
        "backoff_ms": { "type": "integer", "minimum": 0 },
        "max_delay_ms": { "type": "integer", "minimum": 0 },
        "jitter": { "type": "boolean" },
        "when": { "type": "string" },
        "on_error": { "type": "string" },
        "project": { "type": "string" }
      }
    },
    "fallback_config": {
      "type": "object",
      "required": ["primary", "backup"],
      "properties": {
        "name": { "type": "string" },
        "description": { "type": "string" },
        "primary": { "$ref": "#/$defs/node" },
        "backup": { "$ref": "#/$defs/node" },
        "when": { "type": "string" },
        "handoff": { "type": "string" },
        "project": { "type": "string" }
      }
    },
    "timeout_config": {
      "type": "object",
      "required": ["do", "ms"],
      "properties": {
        "name": { "type": "string" },
        "description": { "type": "string" },
        "do": { "$ref": "#/$defs/node" },
        "ms": { "type": "integer", "minimum": 1 }
      }
    },
    "compose_node_config": {
      "type": "object",
      "required": ["name", "do"],
      "properties": {
        "name": { "type": "string", "minLength": 1 },
        "description": { "type": "string" },
        "do": { "$ref": "#/$defs/node" }
      }
    },
    "loop_config": {
      "type": "object",
      "required": ["init", "body", "finish", "max_rounds"],
      "properties": {
        "name": { "type": "string", "minLength": 1 },
        "description": { "type": "string" },
        "init": { "type": "string" },
        "body": { "$ref": "#/$defs/node" },
        "guard": {
          "anyOf": [{ "$ref": "#/$defs/node" }, { "type": "string" }]
        },
        "finish": { "type": "string" },
        "max_rounds": { "type": "integer", "minimum": 1 }
      }
    },
    "adversarial_config": {
      "type": "object",
      "required": ["build", "critique", "accept", "max_rounds"],
      "properties": {
        "name": { "type": "string" },
        "description": { "type": "string" },
        "build": { "$ref": "#/$defs/node" },
        "critique": { "$ref": "#/$defs/node" },
        "accept": { "type": "string" },
        "max_rounds": { "type": "integer", "minimum": 1 },
        "project": { "type": "string" }
      }
    },
    "ensemble_config": {
      "type": "object",
      "required": ["members", "score"],
      "properties": {
        "name": { "type": "string" },
        "description": { "type": "string" },
        "members": {
          "type": "object",
          "additionalProperties": { "$ref": "#/$defs/node" }
        },
        "score": { "type": "string" },
        "select": { "type": "string", "enum": ["max", "min"] },
        "project": { "type": "string" }
      }
    },
    "tournament_config": {
      "type": "object",
      "required": ["members", "compare"],
      "properties": {
        "name": { "type": "string" },
        "description": { "type": "string" },
        "members": {
          "type": "object",
          "additionalProperties": { "$ref": "#/$defs/node" }
        },
        "compare": { "type": "string" },
        "project": { "type": "string" }
      }
    },
    "consensus_config": {
      "type": "object",
      "required": ["members", "agree", "max_rounds"],
      "properties": {
        "name": { "type": "string" },
        "description": { "type": "string" },
        "members": {
          "type": "object",
          "additionalProperties": { "$ref": "#/$defs/node" }
        },
        "agree": { "type": "string" },
        "max_rounds": { "type": "integer", "minimum": 1 },
        "project": { "type": "string" }
      }
    },
    "ensemble_step_config": {
      "type": "object",
      "required": ["members", "score", "rank_by"],
      "properties": {
        "name": { "type": "string" },
        "description": { "type": "string" },
        "members": {
          "type": "object",
          "additionalProperties": { "$ref": "#/$defs/node" }
        },
        "score": { "$ref": "#/$defs/node" },
        "rank_by": { "type": "string" },
        "select": { "type": "string", "enum": ["max", "min"] },
        "project": { "type": "string" }
      }
    },
    "gate_config": {
      "type": "object",
      "required": ["do", "id"],
      "properties": {
        "id": { "type": "string" },
        "name": { "type": "string" },
        "description": { "type": "string" },
        "do": { "$ref": "#/$defs/node" },
        "store": { "type": "string" },
        "format": { "type": "string" }
      }
    },
    "improve_config": {
      "type": "object",
      "required": ["seed", "propose", "score", "budget"],
      "properties": {
        "name": { "type": "string" },
        "description": { "type": "string" },
        "seed": { "$ref": "#/$defs/node" },
        "propose": { "$ref": "#/$defs/node" },
        "score": { "$ref": "#/$defs/node" },
        "budget": { "$ref": "#/$defs/improve_budget" },
        "epsilon": { "type": "number" },
        "proposers_per_round": { "type": "integer", "minimum": 1 },
        "lessons_capacity": { "type": "integer", "minimum": 0 },
        "project": { "type": "string" }
      }
    },
    "improve_budget": {
      "type": "object",
      "required": ["max_rounds", "patience"],
      "properties": {
        "max_rounds": { "type": "integer", "minimum": 1 },
        "max_wallclock_ms": { "type": "integer", "minimum": 0 },
        "patience": { "type": "integer", "minimum": 0 }
      }
    },
    "learn_config": {
      "type": "object",
      "required": ["flow", "source", "analyzer"],
      "properties": {
        "name": { "type": "string" },
        "description": { "type": "string" },
        "flow": { "$ref": "#/$defs/node" },
        "source": { "$ref": "#/$defs/learn_source" },
        "analyzer": { "$ref": "#/$defs/node" },
        "filter": { "type": "string" },
        "max_events": { "type": "integer", "minimum": 1 }
      }
    },
    "learn_source": {
      "type": "object",
      "oneOf": [
        { "$ref": "#/$defs/learn_events_source" },
        { "$ref": "#/$defs/learn_paths_source" },
        { "$ref": "#/$defs/learn_dir_source" }
      ]
    },
    "learn_events_source": {
      "type": "object",
      "required": ["kind", "events"],
      "properties": {
        "kind": { "type": "string", "enum": ["events"] },
        "events": {
          "type": "array",
          "items": {
            "type": "object",
            "required": ["kind"],
            "properties": { "kind": { "type": "string" } }
          }
        }
      }
    },
    "learn_paths_source": {
      "type": "object",
      "required": ["kind", "paths"],
      "properties": {
        "kind": { "type": "string", "enum": ["paths"] },
        "paths": {
          "type": "array",
          "items": { "type": "string" }
        }
      }
    },
    "learn_dir_source": {
      "type": "object",
      "required": ["kind", "dir"],
      "properties": {
        "kind": { "type": "string", "enum": ["dir"] },
        "dir": { "type": "string" }
      }
    },
    "checkpoint_config": {
      "type": "object",
      "required": ["do", "key"],
      "properties": {
        "name": { "type": "string" },
        "description": { "type": "string" },
        "do": { "$ref": "#/$defs/node" },
        "key": { "type": "string" },
        "on_write_error": { "type": "string", "enum": ["record", "fail"] }
      }
    },
    "suspend_config": {
      "type": "object",
      "required": ["id", "on", "resume_schema", "combine"],
      "properties": {
        "id": { "type": "string" },
        "name": { "type": "string" },
        "description": { "type": "string" },
        "on": { "type": "string" },
        "resume_schema": { "type": "string" },
        "combine": { "type": "string" },
        "deadline_ms": { "type": "number" }
      }
    },
    "scope_config": {
      "type": "array",
      "items": { "$ref": "#/$defs/scope_entry" }
    },
    "scope_entry": {
      "type": "object",
      "oneOf": [
        { "$ref": "#/$defs/stash_entry" },
        { "$ref": "#/$defs/use_entry" },
        { "$ref": "#/$defs/node" }
      ]
    },
    "stash_entry": {
      "type": "object",
      "required": ["stash", "do"],
      "properties": {
        "name": { "type": "string" },
        "description": { "type": "string" },
        "stash": { "type": "string" },
        "do": { "$ref": "#/$defs/node" }
      }
    },
    "use_entry": {
      "type": "object",
      "required": ["use", "fn"],
      "properties": {
        "name": { "type": "string" },
        "description": { "type": "string" },
        "use": {
          "type": "array",
          "items": { "type": "string" }
        },
        "fn": { "type": "string" }
      }
    },
    "chain_config": {
      "type": "object",
      "required": ["steps", "output"],
      "properties": {
        "input": { "type": "string" },
        "steps": {
          "type": "array",
          "items": { "$ref": "#/$defs/chain_entry" }
        },
        "output": { "type": "string" }
      }
    },
    "chain_entry": {
      "type": "object",
      "oneOf": [
        { "$ref": "#/$defs/chain_step_entry" },
        { "$ref": "#/$defs/chain_arm_entry" },
        { "$ref": "#/$defs/chain_stage_entry" }
      ]
    },
    "chain_step_entry": {
      "type": "object",
      "required": ["step", "fn"],
      "properties": {
        "name": { "type": "string" },
        "description": { "type": "string" },
        "step": { "type": "string" },
        "fn": { "type": "string" },
        "arm": { "$ref": "#/$defs/arms" }
      }
    },
    "chain_arm_entry": {
      "type": "object",
      "required": ["step", "arm", "select"],
      "properties": {
        "name": { "type": "string" },
        "description": { "type": "string" },
        "step": { "type": "string" },
        "arm": { "$ref": "#/$defs/node" },
        "select": { "type": "string" }
      }
    },
    "chain_stage_entry": {
      "type": "object",
      "required": ["stage"],
      "properties": {
        "stage": { "type": "string" },
        "project": { "type": "string" }
      }
    }
  }
}
