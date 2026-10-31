# Security

## Supported versions

Only the latest release gets fixes, Chromium's security updates included:
update to it before reporting.

## Reporting a vulnerability

Report privately, with "Report a vulnerability" on this repository's
Security tab, or by email to contact@pdfkiln.org. Please do not open a
public issue.

A useful report gives the version (`pdfkiln --version`), the system, the
command line, and a page that reproduces the problem.

## Scope

PDFKiln renders HTML that may come from third parties. In scope: a page
that reaches what the command line did not allow (local files, the private
network, other hosts), escapes Chromium's sandbox, or runs code on the
machine. A flaw in Chromium itself goes to the Chromium project; tell us if
a PDFKiln release still ships an affected version.
