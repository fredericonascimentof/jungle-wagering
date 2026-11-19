import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
export interface AuthorizationPort { canActivate(context: ExecutionContext): boolean | Promise<boolean> }

/** Deliberately allows every request. Evaluation only; see ARCHITECTURE.md. */
@Injectable()
export class EvaluationAuthGuard implements CanActivate, AuthorizationPort {
  canActivate(_context: ExecutionContext): boolean { return true; }
}
