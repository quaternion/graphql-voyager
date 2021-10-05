import {
  buildClientSchema,
  introspectionFromSchema,
  IntrospectionSchema,
  IntrospectionType,
  lexicographicSortSchema,
} from 'graphql'
import * as _ from 'lodash'

import { SimplifiedIntrospection, SimplifiedIntrospectionWithIds, SimplifiedType } from './types'
import { typeNameToId } from './utils'

function unwrapType(type, wrappers) {
  while (type.kind === 'NON_NULL' || type.kind == 'LIST') {
    wrappers.push(type.kind);
    type = type.ofType;
  }

  return type.name;
}

function convertArg(inArg) {
  var outArg = <any>{
    name: inArg.name,
    description: inArg.description,
    defaultValue: inArg.defaultValue,
    typeWrappers: [],
  };
  outArg.type = unwrapType(inArg.type, outArg.typeWrappers);

  return outArg;
}

let convertInputField = convertArg;

function convertField(inField) {
  var outField = <any>{
    name: inField.name,
    description: inField.description,
    typeWrappers: [],
    isDeprecated: inField.isDeprecated,
  };

  outField.type = unwrapType(inField.type, outField.typeWrappers);

  outField.args = _(inField.args).map(convertArg).keyBy('name').value();

  if (outField.isDeprecated)
    outField.deprecationReason = inField.deprecationReason;

  return outField;
}

function convertType(inType: IntrospectionType): SimplifiedType {
  const outType: SimplifiedType = {
    kind: inType.kind,
    name: inType.name,
    description: inType.description,
  };

  switch (inType.kind) {
    case 'OBJECT':
      outType.interfaces = _(inType.interfaces).map('name').uniq().value();
      outType.fields = _(inType.fields).map(convertField).keyBy('name').value();
      break;
    case 'INTERFACE':
      outType.derivedTypes = _(inType.possibleTypes).map('name').uniq().value();
      outType.fields = _(inType.fields).map(convertField).keyBy('name').value();
      break;
    case 'UNION':
      outType.possibleTypes = _(inType.possibleTypes)
        .map('name')
        .uniq()
        .value();
      break;
    case 'ENUM':
      outType.enumValues = inType.enumValues.slice();
      break;
    case 'INPUT_OBJECT':
      outType.inputFields = _(inType.inputFields)
        .map(convertInputField)
        .keyBy('name')
        .value();
      break;
  }

  return outType;
}

function simplifySchema(
  inSchema: IntrospectionSchema,
): SimplifiedIntrospection {
  return {
    types: _(inSchema.types).map(convertType).keyBy('name').value(),
    queryType: inSchema.queryType.name,
    mutationType: _.get(inSchema, 'mutationType.name', null),
    subscriptionType: _.get(inSchema, 'subscriptionType.name', null),
    //FIXME:
    //directives:
  };
}

function markHiddenTypes(schema: SimplifiedIntrospectionWithIds, hideRules: {
  pattern: string
  proxyField?: string
}[]): void {
  _.each(schema.types, type => {
    _.each(hideRules, hideRule => {
      const patternRegExp = new RegExp(hideRule.pattern)
      if (patternRegExp.test(type.name)) {
        type.isHiddenType = true
        if (hideRule.proxyField) {
          type.hiddenOptions = { replaceField: hideRule.proxyField }
        }
      }
    })
  });

  _.each(schema.types, type => {
    if (type.isHiddenType) return;
    
    _.each(type.fields, field => {
      if (field.type.isHiddenType && field.type.hiddenOptions) {
        const proxyFieldName = field.type.hiddenOptions.replaceField
        const proxyType = field.type.fields[proxyFieldName].type
        field.typeWrappers = field.type.fields[proxyFieldName].typeWrappers
        field.type = proxyType
      }
    });
  });
}

function markDeprecated(schema: SimplifiedIntrospectionWithIds): void {
  // Remove deprecated fields.
  _.each(schema.types, (type) => {
    type.fields = _.pickBy(type.fields, (field) => !field.isDeprecated);
  });

  // We can't remove types that end up being empty
  // because we cannot be sure that the @deprecated directives where
  // consistently added to the schema we're handling.
  //
  // Entities may have non deprecated fields pointing towards entities
  // which are deprecated.
}

function assignTypesAndIDs(schema: SimplifiedIntrospection) {
  (<any>schema).queryType = schema.types[schema.queryType];
  (<any>schema).mutationType = schema.types[schema.mutationType];
  (<any>schema).subscriptionType = schema.types[schema.subscriptionType];

  _.each(schema.types, (type: any) => {
    type.id = typeNameToId(type.name);

    _.each(type.inputFields, (field: any) => {
      field.id = `FIELD::${type.name}::${field.name}`;
      field.type = schema.types[field.type];
    });

    _.each(type.fields, (field: any) => {
      field.id = `FIELD::${type.name}::${field.name}`;
      field.type = schema.types[field.type];
      _.each(field.args, (arg: any) => {
        arg.id = `ARGUMENT::${type.name}::${field.name}::${arg.name}`;
        arg.type = schema.types[arg.type];
      });
    });

    if (!_.isEmpty(type.possibleTypes)) {
      type.possibleTypes = _.map(
        type.possibleTypes,
        (possibleType: string) => ({
          id: `POSSIBLE_TYPE::${type.name}::${possibleType}`,
          type: schema.types[possibleType],
        }),
      );
    }

    if (!_.isEmpty(type.derivedTypes)) {
      type.derivedTypes = _.map(type.derivedTypes, (derivedType: string) => ({
        id: `DERIVED_TYPE::${type.name}::${derivedType}`,
        type: schema.types[derivedType],
      }));
    }

    if (!_.isEmpty(type.interfaces)) {
      type.interfaces = _.map(type.interfaces, (baseType: string) => ({
        id: `INTERFACE::${type.name}::${baseType}`,
        type: schema.types[baseType],
      }));
    }
  });

  schema.types = _.keyBy(schema.types, 'id');
}

export function getSchema(
  introspection: any,
  sortByAlphabet: boolean,
  skipDeprecated: boolean,
  showHidden: boolean,
  hideRules: {
    pattern: string
    replaceField?: string
  }[]
) {
  if (!introspection) return null;

  let schema = buildClientSchema(introspection.data);
  if (sortByAlphabet) {
    schema = lexicographicSortSchema(schema);
  }

  introspection = introspectionFromSchema(schema, { descriptions: true });
  let simpleSchema = simplifySchema(introspection.__schema);

  assignTypesAndIDs(simpleSchema);

  if (!showHidden && hideRules.length) {
    markHiddenTypes((<any>simpleSchema) as SimplifiedIntrospectionWithIds, hideRules);
  }

  if (skipDeprecated) {
    markDeprecated((<any>simpleSchema) as SimplifiedIntrospectionWithIds);
  }
  return simpleSchema;
}
