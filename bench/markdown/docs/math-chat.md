# Solving a quadratic equation

This is how a chat assistant typically writes math: inline with `\( … \)` or `$ … $`, displayed with `\[ … \]` or `$$ … $$`.

## The formula

Given \( ax^2 + bx + c = 0 \) with \( a \neq 0 \), the solutions are:

\[
x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}
\]

The quantity under the root is the **discriminant**, written $\Delta = b^2 - 4ac$:

- if $\Delta > 0$, there are two real roots;
- if $\Delta = 0$, there is one double root, $x = -\frac{b}{2a}$;
- if $\Delta < 0$, the roots are complex: $x = \frac{-b \pm i\sqrt{-\Delta}}{2a}$.

## Worked example

Solve $2x^2 - 3x - 5 = 0$.

1. Identify the coefficients: $a = 2$, $b = -3$, $c = -5$.
2. Compute the discriminant:
   $$
   \Delta = (-3)^2 - 4 \cdot 2 \cdot (-5) = 9 + 40 = 49
   $$
3. Take the root: $\sqrt{49} = 7$.
4. Apply the formula:
   \[
   x_1 = \frac{3 + 7}{4} = \frac{5}{2}, \qquad x_2 = \frac{3 - 7}{4} = -1
   \]

## A system, a matrix and a sum

$$
\begin{aligned}
2x + 3y &= 7 \\
x - y &= 1
\end{aligned}
\qquad\Longrightarrow\qquad
\begin{pmatrix} 2 & 3 \\ 1 & -1 \end{pmatrix}
\begin{pmatrix} x \\ y \end{pmatrix}
=
\begin{pmatrix} 7 \\ 1 \end{pmatrix}
$$

The sum of the first $n$ integers is $\sum_{k=1}^{n} k = \frac{n(n+1)}{2}$, and

$$
\int_{-\infty}^{\infty} e^{-x^2}\,dx = \sqrt{\pi}.
$$

## Dollars that are not math

The plan costs $5 a month, or $50 a year: you save $10. A price list may read "from $9.99 to $19.99", and a shell variable is written `$HOME`. None of these is a formula, nor is an escaped \$ sign.

## An error

A formula KaTeX cannot read is shown in red with its source, the rest of the document unchanged: $\frac{1}{$.
