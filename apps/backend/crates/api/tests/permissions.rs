//! Permission matrix from docs/architecture.md section 8, as a table.
use taphoa_api::auth::{Action, Actor, Role, can};
use uuid::Uuid;

fn actor(role: Role, can_enroll: bool) -> Actor {
    Actor {
        member_id: Uuid::nil(),
        store_id: Uuid::nil(),
        session_id: Uuid::nil(),
        role,
        can_enroll,
    }
}

#[test]
fn matrix() {
    use Action::*;
    // (action, lead, seller, seller+can_enroll)
    let table = [
        (Sell, true, true, true),
        (AdjustStock, true, false, false),
        (VoidOwnSaleSameDay, true, true, true),
        (VoidAnySale, true, false, false),
        (EnrollProduct, true, false, true),
        (ChangePrice, true, false, false),
        (ArchiveProduct, true, false, false),
        (AddExpense, true, true, true),
        (EditAnyExpense, true, false, false),
        (ReviewQueue, true, false, false),
        (ViewAlerts, true, false, false),
        (RecognitionReport, true, false, false),
        (DayClose, true, false, false),
        (Exports, true, false, false),
        (ManageStore, true, false, false),
        (ManageMembers, true, false, false),
        (ManageInvites, true, false, false),
    ];
    for (action, lead, seller, enroller) in table {
        assert_eq!(
            can(&actor(Role::Lead, true), action),
            lead,
            "lead {action:?}"
        );
        assert_eq!(
            can(&actor(Role::Seller, false), action),
            seller,
            "seller {action:?}"
        );
        assert_eq!(
            can(&actor(Role::Seller, true), action),
            enroller,
            "enroller {action:?}"
        );
    }
}

#[test]
fn receipt_permission_reuses_enrollment_and_lead_does_not_need_flag() {
    // Receipt handlers intentionally use the same permission as catalog enrollment.
    assert!(can(&actor(Role::Lead, false), Action::EnrollProduct));
    assert!(can(&actor(Role::Seller, true), Action::EnrollProduct));
    assert!(!can(&actor(Role::Seller, false), Action::EnrollProduct));
}
