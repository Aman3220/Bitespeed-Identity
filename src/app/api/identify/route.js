import prisma from "@/lib/prisma";
import { NextResponse } from "next/server";

function normalizePhoneNumber(value) {
  if (value == null || value === "") return undefined;
  const s = typeof value === "string" ? value : String(value);
  return s.trim() || undefined;
}

export async function POST(request) {
  try {
    const body = await request.json();
    const email =
      body.email != null && body.email !== "" ? String(body.email) : undefined;
    const phoneNumber = normalizePhoneNumber(body.phoneNumber);

    if (!email && !phoneNumber) {
      return NextResponse.json(
        { error: "Either email or phoneNumber is required" },
        { status: 400 }
      );
    }

    const byEmail = email
      ? await prisma.contact.findMany({ where: { email } })
      : [];
    const byPhone = phoneNumber
      ? await prisma.contact.findMany({
          where: { phoneNumber: String(phoneNumber).trim() },
        })
      : [];
    const seenIds = new Set();
    const matchingContacts = [];
    for (const c of [...byEmail, ...byPhone]) {
      if (!seenIds.has(c.id)) {
        seenIds.add(c.id);
        matchingContacts.push(c);
      }
    }

    if (matchingContacts.length === 0) {
      const primary = await prisma.contact.create({
        data: {
          email: email ?? null,
          phoneNumber: phoneNumber ?? null,
          linkPrecedence: "primary",
        },
      });

      return NextResponse.json({
        contact: {
          primaryContatctId: primary.id,
          emails: primary.email ? [primary.email] : [],
          phoneNumbers: primary.phoneNumber ? [primary.phoneNumber] : [],
          secondaryContactIds: [],
        },
      });
    }

    const contactIds = matchingContacts.map((c) => c.id);
    const primaryIdsFromSecondaries = matchingContacts
      .filter((c) => c.linkedId != null)
      .map((c) => c.linkedId);
    const allContactIds = [...new Set([...contactIds, ...primaryIdsFromSecondaries])];

    const allContacts = await prisma.contact.findMany({
      where: {
        OR: [
          { id: { in: allContactIds } },
          { linkedId: { in: allContactIds } },
        ],
      },
    });


    const primaries = allContacts.filter(
      (c) => c.linkPrecedence === "primary"
    );

    const primary = primaries.sort(
      (a, b) => new Date(a.createdAt) - new Date(b.createdAt)
    )[0];


    for (const c of primaries) {
      if (c.id !== primary.id) {
        await prisma.contact.update({
          where: { id: c.id },
          data: {
            linkPrecedence: "secondary",
            linkedId: primary.id,
          },
        });
      }
    }


    const emailExists = !email || allContacts.some((c) => c.email === email);
    const phoneNorm = phoneNumber != null ? String(phoneNumber).trim() : null;
    const phoneExists =
      !phoneNorm ||
      allContacts.some(
        (c) =>
          c.phoneNumber != null &&
          String(c.phoneNumber).trim() === phoneNorm
      );
    const alreadyExists = emailExists && phoneExists;

    if (!alreadyExists) {
      await prisma.contact.create({
        data: {
          email: email ?? null,
          phoneNumber: phoneNumber ?? null,
          linkPrecedence: "secondary",
          linkedId: primary.id,
        },
      });
    }

    const finalContacts = await prisma.contact.findMany({
      where: {
        OR: [{ id: primary.id }, { linkedId: primary.id }],
      },
    });

    const primaryContact = finalContacts.find((c) => c.id === primary.id);
    const secondaryContacts = finalContacts.filter(
      (c) => c.linkPrecedence === "secondary"
    );
    const allEmails = [
      ...new Set(finalContacts.map((c) => c.email).filter(Boolean)),
    ];
    const allPhones = [
      ...new Set(finalContacts.map((c) => c.phoneNumber).filter(Boolean)),
    ];
    const emails =
      primaryContact?.email != null
        ? [
            primaryContact.email,
            ...allEmails.filter((e) => e !== primaryContact.email),
          ]
        : allEmails;
    const phoneNumbers =
      primaryContact?.phoneNumber != null
        ? [
            primaryContact.phoneNumber,
            ...allPhones.filter((p) => p !== primaryContact.phoneNumber),
          ]
        : allPhones;

    return NextResponse.json({
      contact: {
        primaryContatctId: primary.id,
        emails,
        phoneNumbers,
        secondaryContactIds: secondaryContacts.map((c) => c.id),
      },
    });
  } catch (error) {
    console.error("Identify Error:", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}