# CodeQL only covers javascript-typescript (see .github/workflows/codeql.yml)
# -- the Windows installer (install.ps1) and Linux/Windows bootstrap scripts
# in this directory have no static analysis at all otherwise, which is how
# the credential-directory ACL-ordering bug in install.ps1 shipped
# unnoticed (see docs/security-audit.md).
#
# PSScriptAnalyzer's default rule set is not that: most of it is style and
# best-practice noise for a script whose entire job is talking to an
# interactive console (Write-Host is the point here, not a bug to fix).
# Scoped instead to the handful of rules that would actually catch a
# regression into a real credential-handling bug -- a parameter that takes a
# password as plain text, ConvertTo-SecureString with -AsPlainText, a broken
# hash algorithm, blind Invoke-Expression, an empty catch swallowing a
# failure silently. Widen this list when a real finding earns it, not
# preemptively.
@{
    IncludeRules = @(
        'PSAvoidUsingPlainTextForPassword',
        'PSAvoidUsingConvertToSecureStringWithPlainText',
        'PSAvoidUsingUsernameAndPasswordParams',
        'PSUsePSCredentialType',
        'PSAvoidUsingInvokeExpression',
        'PSAvoidUsingBrokenHashAlgorithms',
        'PSAvoidUsingComputerNameHardcoded',
        'PSAvoidUsingWMICmdlet',
        'PSAvoidUsingEmptyCatchBlock'
    )
}
