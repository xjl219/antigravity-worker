// A 403 can describe a model or project permission rather than the account.
// Only an authentication failure proves saved credentials are invalid.
export function statusForFailure(status:number):"ACTIVE"|"BLOCKED"{
  return status===401?"BLOCKED":"ACTIVE";
}
