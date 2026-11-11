import { applyDecorators } from '@nestjs/common';
import { ApiBody, ApiQuery, ApiResponse } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { z } from 'zod';

function schemaOf(schema: z.ZodType): SchemaObject {
  const { $schema: _dialect, ...object } = z.toJSONSchema(schema, { target: 'openapi-3.0', io: 'input' });
  return object as SchemaObject;
}

export function JsonBody(schema: z.ZodType, example?: Record<string, unknown>) {
  return ApiBody({ schema: { ...schemaOf(schema), example } });
}

export function JsonBodyVariants(schemas: z.ZodType[]) {
  return ApiBody({ schema: { anyOf: schemas.map(schemaOf) } });
}

export function QueryFields(schema: z.ZodType) {
  const { properties, required } = schemaOf(schema);
  return applyDecorators(...Object.entries(properties ?? {}).map(([name, property]) =>
    ApiQuery({ name, required: required?.includes(name) ?? false, schema: property })));
}

export function JsonResponse(data: z.ZodType, status = 200) {
  return ApiResponse({ status, schema: schemaOf(z.object({ data, requestId: z.uuid() })) });
}
